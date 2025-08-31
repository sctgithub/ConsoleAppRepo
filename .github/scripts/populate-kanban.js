const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const core = require("@actions/core");
const github = require("@actions/github");

const token = process.env.PROJECTS_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = process.env.OWNER;
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER);
const STATUS_FIELD_NAME = process.env.STATUS_FIELD_NAME || "Status";
const TASKS_DIR = process.env.TASKS_DIR || "Tasks";
const RELATIONSHIP_HEADER = process.env.RELATIONSHIP_HEADER || "Relationships";
const COMMENT_HEADER = process.env.COMMENT_HEADER || "Automated Notes";
const SYNC_LABEL = "auto-sync"; // Label to identify sync-managed issues

if (!token) { core.setFailed("PROJECTS_TOKEN missing"); process.exit(1); }
if (!OWNER || !PROJECT_NUMBER) { core.setFailed("OWNER/PROJECT_NUMBER missing"); process.exit(1); }

const octokit = github.getOctokit(token);

const mdToBool = v => typeof v === "string" ? v.trim().length > 0 : !!v;

// Helper function to write YAML with proper formatting
function writeMarkdownWithYAML(filePath, content, frontmatter) {
    const yamlOptions = {
        lineWidth: -1,      // Don't wrap long lines
        noRefs: true,       // Don't use YAML references  
        quotingType: '"',   // Use double quotes when needed
        forceQuotes: false, // Only quote when necessary
        flowLevel: -1       // Use block style for arrays and objects
    };

    fs.writeFileSync(filePath, matter.stringify(content, frontmatter, { yaml: yamlOptions }));
}

// Function to selectively enhance description - DISABLED by default
function enhanceDescriptionSelectively(originalDescription, frontmatter) {
    if (!originalDescription) originalDescription = "";

    // Check if enhancement is explicitly enabled (changed default behavior)
    if (frontmatter && frontmatter.enhanceDescription === true) {
        console.log('Description enhancement enabled by frontmatter flag');

        const formatElements = [
            {
                check: /^###\s+/m,
                template: "### Heading"
            },
            {
                check: /\*\*.*?\*\*/,
                template: "**Bold text example**"
            },
            {
                check: /\*.*?\*/,
                template: "*Italic text example*"
            },
            {
                check: /^>\s+/m,
                template: "> This is a quote block for important notes"
            },
            {
                check: /`.*?`/,
                template: "`Code snippet example`"
            },
            {
                check: /\[.*?\]\(.*?\)/,
                template: "[Link example](https://github.com)"
            },
            {
                check: /^-\s+/m,
                template: "- Unordered list item 1\n- Unordered list item 2\n- Unordered list item 3"
            },
            {
                check: /^\d+\.\s+/m,
                template: "1. Numbered list item 1\n2. Numbered list item 2\n3. Numbered list item 3"
            },
            {
                check: /^-\s+\[\s*[x\s]\]\s+/m,
                template: "**Task Checklist:**\n- [ ] Task 1 to complete\n- [ ] Task 2 to complete\n- [ ] Task 3 to complete"
            }
        ];

        //const missingElements = [];

        // Check which elements are missing
        //for (const element of formatElements) {
        //    if (!element.check.test(originalDescription)) {
        //        missingElements.push(element.template);
        //    }
        //}

        // Add missing elements at the top if any
        //if (missingElements.length > 0) {
        //    const enhancedDescription = missingElements.join("\n\n") + "\n\n---\n\n";
        //    console.log(`Added ${missingElements.length} missing formatting elements`);
        //    return enhancedDescription + originalDescription;
        //}
    }

    console.log('Description enhancement disabled (default behavior)');
    return originalDescription;
}

// ---------- GraphQL helpers ----------
async function getProjectNode() {
    const orgQ = `query($login:String!,$number:Int!){ organization(login:$login){ projectV2(number:$number){ id title }}}`;
    const userQ = `query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id title }}}`;
    const asOrg = await octokit.graphql(orgQ, { login: OWNER, number: PROJECT_NUMBER }).catch(() => null);
    if (asOrg?.organization?.projectV2) return asOrg.organization.projectV2;
    const asUser = await octokit.graphql(userQ, { login: OWNER, number: PROJECT_NUMBER }).catch(() => null);
    if (asUser?.user?.projectV2) return asUser.user.projectV2;
    throw new Error(`Project v2 #${PROJECT_NUMBER} not found for ${OWNER}`);
}

async function getProjectFields(projectId) {
    const q = `
    query($projectId:ID!){
      node(id:$projectId){
        ... on ProjectV2 {
          fields(first:100){
            nodes{
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { id name dataType options{ id name } }
            }
          }
        }
      }
    }`;
    const res = await octokit.graphql(q, { projectId });
    const fields = res.node.fields.nodes;
    const map = new Map(fields.map(f => [f.name, f]));
    return { fields, map };
}

// Get all issues from the project (for deletion detection)
async function getProjectIssues(projectId) {
    console.log(`Fetching issues from project ID: ${projectId} for deletion detection`);

    const query = `
    query($projectId:ID!, $cursor:String) {
      node(id:$projectId) {
        ... on ProjectV2 {
          items(first:100, after:$cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              content {
                ... on Issue {
                  id
                  number
                  title
                  body
                  state
                  labels(first:20) {
                    nodes {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`;

    let allIssues = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
        const result = await octokit.graphql(query, { projectId, cursor });
        const items = result.node.items;

        // Filter for issues only (exclude draft issues and PRs)
        const issues = items.nodes.filter(item => {
            return item.content &&
                item.content.number &&
                item.content.title &&
                item.content.state !== 'CLOSED';
        });

        allIssues.push(...issues);

        hasNextPage = items.pageInfo.hasNextPage;
        cursor = items.pageInfo.endCursor;
    }

    console.log(`Found ${allIssues.length} open issues in project for deletion check`);
    return allIssues;
}

async function addIssueToProject(projectId, issueNodeId) {
    const m = `
    mutation($projectId:ID!,$contentId:ID!){
      addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}){
        item{ id }
      }
    }`;
    const res = await octokit.graphql(m, { projectId, contentId: issueNodeId });
    return res.addProjectV2ItemById.item.id;
}

async function setFieldValue({ projectId, itemId, field, value }) {
    if (!field) return;
    const base = { projectId, itemId, fieldId: field.id };
    let val = null;

    switch (field.dataType) {
        case "SINGLE_SELECT": {
            const opt = field.options.find(o => o.name.toLowerCase() === String(value).trim().toLowerCase());
            if (!opt) return;
            val = { singleSelectOptionId: opt.id };
            break;
        }
        case "NUMBER": {
            const n = Number(value);
            if (Number.isNaN(n)) return;
            val = { number: n };
            break;
        }
        case "DATE": {
            const s = String(value).trim();
            if (!s) return;
            val = { date: s }; // YYYY-MM-DD
            break;
        }
        case "TEXT": {
            const s = String(value ?? "").trim();
            if (!s) return;
            val = { text: s };
            break;
        }
        default:
            return;
    }

    const m = `
    mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:ProjectV2FieldValue!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$projectId, itemId:$itemId, fieldId:$fieldId, value:$value
      }){ projectV2Item{ id } }
    }`;
    await octokit.graphql(m, { ...base, value: val });
}

// ---------- Issue helpers ----------

function repoContext() { return github.context.repo; }

async function ensureLabels({ owner, repo, labels }) {
    if (!labels?.length) return;
    try {
        const existing = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
        const names = new Set(existing.map(l => l.name.toLowerCase()));
        for (const lb of labels) {
            if (!names.has(lb.toLowerCase())) {
                await octokit.rest.issues.createLabel({ owner, repo, name: lb });
            }
        }
    } catch { /* ignore create failures (race) */ }
}

async function setIssueBasics({ owner, repo, issueNumber, assignees, labels, milestoneTitle }) {
    // Ensure sync label is always included
    const allLabels = Array.isArray(labels) ? [...labels] : [];
    if (!allLabels.includes(SYNC_LABEL)) {
        allLabels.push(SYNC_LABEL);
    }

    await ensureLabels({ owner, repo, labels: allLabels });
    let milestone = undefined;
    if (milestoneTitle) {
        const m = await octokit.rest.issues.listMilestones({ owner, repo, state: "open" });
        const found = m.data.find(mi => mi.title.toLowerCase() === milestoneTitle.toLowerCase());
        if (found) milestone = found.number;
    }
    await octokit.rest.issues.update({
        owner, repo, issue_number: issueNumber,
        assignees, labels: allLabels, milestone
    });
}

// Function to update issue title and body
async function updateIssueContent({ owner, repo, issueNumber, title, body }) {
    try {
        await octokit.rest.issues.update({
            owner,
            repo,
            issue_number: issueNumber,
            title: title,
            body: body
        });
        console.log(`Updated issue #${issueNumber} title and body`);
    } catch (error) {
        console.warn(`Failed to update issue #${issueNumber} content:`, error.message);
    }
}

// Function to create sub-issues and link them
async function createSubIssues({ owner, repo, parentIssueNumber, subIssues, filePath, project, fieldMap }) {
    if (!Array.isArray(subIssues) || !subIssues.length) return [];

    const createdSubIssues = [];

    for (let i = 0; i < subIssues.length; i++) {
        const subIssue = subIssues[i];
        try {
            let subIssueData;

            // Check if sub-issue already exists
            if (subIssue.issue) {
                try {
                    const existing = await octokit.rest.issues.get({
                        owner,
                        repo,
                        issue_number: subIssue.issue
                    });
                    subIssueData = existing.data;
                    console.log(`Using existing sub-issue #${subIssue.issue}`);
                } catch (error) {
                    console.warn(`Sub-issue #${subIssue.issue} not found, will create new one`);
                    subIssue.issue = null; // Reset to create new one
                }
            }

            // Create new sub-issue if it doesn't exist
            if (!subIssueData) {
                // Enhanced sub-issue description with selective formatting
                const enhancedSubDescription = enhanceDescriptionSelectively(subIssue.description, subIssue);
                const subIssueBody = `${enhancedSubDescription}\n\n**Parent issue:** #${parentIssueNumber}\n\n<!-- SYNC-MANAGED -->`;

                const created = await octokit.rest.issues.create({
                    owner,
                    repo,
                    title: subIssue.title || "Sub-task",
                    body: subIssueBody,
                    labels: [SYNC_LABEL] // Add sync label to sub-issues
                });
                subIssueData = created.data;
                subIssues[i].issue = created.data.number; // Update the subIssue object
                console.log(`Created sub-issue #${created.data.number} for parent #${parentIssueNumber}`);
            } else {
                // Update existing sub-issue title and body with selective formatting
                const enhancedSubDescription = enhanceDescriptionSelectively(subIssue.description, subIssue);
                const subIssueBody = `${enhancedSubDescription}\n\n**Parent issue:** #${parentIssueNumber}\n\n<!-- SYNC-MANAGED -->`;

                await updateIssueContent({
                    owner,
                    repo,
                    issueNumber: subIssue.issue,
                    title: subIssue.title || "Sub-task",
                    body: subIssueBody
                });
            }

            createdSubIssues.push({
                number: subIssueData.number,
                title: subIssueData.title,
                url: subIssueData.html_url,
                node_id: subIssueData.node_id
            });

            // Add to project
            const itemId = await addIssueToProject(project.id, subIssueData.node_id);

            // Handle sub-issue properties (assignees, labels, milestone)
            const assignees = Array.isArray(subIssue.assignees) ? subIssue.assignees : [];
            const labels = Array.isArray(subIssue.labels) ? subIssue.labels : [];
            const milestoneTitle = (subIssue.milestone || "").trim();
            await setIssueBasics({
                owner,
                repo,
                issueNumber: subIssueData.number,
                assignees,
                labels,
                milestoneTitle
            });

            // Handle sub-issue comments with history
            if (Array.isArray(subIssue.comments) && subIssue.comments.length) {
                await handleCommentsWithHistory({
                    owner,
                    repo,
                    issue_number: subIssueData.number,
                    header: COMMENT_HEADER,
                    comments: subIssue.comments,
                    filePath: filePath, // We'll handle this differently for sub-issues
                    frontmatter: subIssue, // Pass the sub-issue data as frontmatter
                    isSubIssue: true
                });
            }

            // Set project fields for sub-issue
            const desired = {
                [STATUS_FIELD_NAME]: subIssue.status,
                "Sprint": subIssue.sprint,
                "Priority": subIssue.priority,
                "Size": subIssue.size,
                "Estimate": subIssue.estimate,
                "Dev Hours": subIssue.devHours,
                "QA Hours": subIssue.qaHours,
                "Planned Start": subIssue.plannedStart,
                "Planned End": subIssue.plannedEnd,
                "Actual Start": subIssue.actualStart,
                "Actual End": subIssue.actualEnd
            };

            for (const [name, val] of Object.entries(desired)) {
                const field = fieldMap.get(name);
                if (field && mdToBool(val)) {
                    await setFieldValue({ projectId: project.id, itemId, field, value: val });
                    console.log(`Set sub-issue field ${name} = ${val} for #${subIssueData.number}`);
                }
            }

        } catch (error) {
            console.warn(`Failed to process sub-issue for #${parentIssueNumber}:`, error.message);
        }
    }

    // Update the markdown file with the created/updated sub-issue numbers
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = matter(raw);
        parsed.data.subIssues = subIssues; // Update with the modified subIssues array
        writeMarkdownWithYAML(filePath, parsed.content, parsed.data);
        console.log(`Updated sub-issues in ${filePath}`);
    } catch (error) {
        console.warn(`Failed to update sub-issues in markdown file:`, error.message);
    }

    return createdSubIssues;
}

async function findOrCreateIssue({ owner, repo, filePath, fmTitle, body, existingIssue, frontmatterData }) {
    if (existingIssue) {
        // Verify it exists
        try {
            const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: existingIssue });
            return { number: data.number, node_id: data.node_id, html_url: data.html_url, created: false };
        } catch { /* fall through to create */ }
    }

    // Skip the deprecated search API and create new issue directly
    console.log(`Creating new issue for: ${fmTitle}`);

    // Create with selective description enhancement and sync marker
    const enhancedBody = enhanceDescriptionSelectively(body, frontmatterData || {});
    const bodyWithMarker = `${enhancedBody}\n\n<!-- SYNC-MANAGED -->`;

    const created = await octokit.rest.issues.create({
        owner,
        repo,
        title: fmTitle,
        body: bodyWithMarker,
        labels: [SYNC_LABEL] // Add sync label to new issues
    });

    // Write back issue number into the md file immediately
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    parsed.data.issue = created.data.number;
    writeMarkdownWithYAML(filePath, parsed.content, parsed.data);
    return { number: created.data.number, node_id: created.data.node_id, html_url: created.data.html_url, created: true };
}

// Function to upload image to GitHub repository
async function uploadImageToGitHub({ owner, repo, imagePath, commitMessage = "Add image for issue comment" }) {
    try {
        if (!fs.existsSync(imagePath)) {
            console.warn(`Image file not found: ${imagePath}`);
            return null;
        }

        const imageBuffer = fs.readFileSync(imagePath);
        const imageBase64 = imageBuffer.toString('base64');
        const fileName = path.basename(imagePath);
        const timestamp = Date.now();
        const repoPath = `images/uploads/${timestamp}-${fileName}`;

        // Check if file already exists in repo
        try {
            await octokit.rest.repos.getContent({
                owner,
                repo,
                path: repoPath
            });
            console.log(`Image already exists in repo: ${repoPath}`);
            return `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`;
        } catch {
            // File doesn't exist, proceed with upload
        }

        // Upload image to repository
        await octokit.rest.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: repoPath,
            message: commitMessage,
            content: imageBase64
        });

        console.log(`Uploaded image to: ${repoPath}`);
        // Return the raw GitHub URL for the image
        return `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`;
    } catch (error) {
        console.warn(`Failed to upload image ${imagePath}:`, error.message);
        return null;
    }
}

// Function to process comments and handle image uploads
async function processCommentWithImages({ owner, repo, commentText, baseDir = "" }) {
    // Look for image references in the format: [IMAGE:path/to/image.png]
    const imageRegex = /\[IMAGE:(.*?)\]/g;
    let processedComment = commentText;
    const matches = [];
    let match;

    // Collect all image matches first
    const originalComment = commentText;
    while ((match = imageRegex.exec(originalComment)) !== null) {
        matches.push({
            fullMatch: match[0],
            imagePath: match[1].trim()
        });
    }

    // Process each image sequentially
    for (const imageMatch of matches) {
        const imagePath = imageMatch.imagePath;
        let fullImagePath;

        // Handle relative paths
        if (path.isAbsolute(imagePath)) {
            fullImagePath = imagePath;
        } else {
            // Resolve relative to the baseDir (where the .md file is)
            fullImagePath = path.resolve(baseDir, imagePath);
        }

        if (fs.existsSync(fullImagePath)) {
            console.log(`Processing image: ${imagePath} (${fullImagePath})`);
            const imageUrl = await uploadImageToGitHub({
                owner,
                repo,
                imagePath: fullImagePath,
                commitMessage: `Add image for issue comment: ${path.basename(imagePath)}`
            });

            if (imageUrl) {
                // Replace [IMAGE:path] with markdown image syntax
                const imageName = path.basename(imagePath, path.extname(imagePath));
                const replacement = `![${imageName}](${imageUrl})`;
                processedComment = processedComment.replace(imageMatch.fullMatch, replacement);
                console.log(`Converted image reference: ${imageMatch.fullMatch} → ${replacement}`);
            } else {
                console.warn(`Failed to upload image: ${imagePath}, keeping original reference`);
                // Keep the original reference if upload failed
            }
        } else {
            console.warn(`Image not found: ${fullImagePath}, keeping original reference`);
            // Keep the original reference if file doesn't exist
        }
    }

    return processedComment;
}

// Comment History System - Modified to handle sub-issues and images
async function handleCommentsWithHistory({ owner, repo, issue_number, header, comments, filePath, frontmatter, isSubIssue = false }) {
    if (!Array.isArray(comments) || !comments.length) return false;

    // Get the directory where the markdown file is located
    const baseDir = path.dirname(filePath);

    // For sub-issues, we work directly with the frontmatter object instead of re-reading file
    let latestData;
    if (isSubIssue) {
        latestData = frontmatter;
    } else {
        // Always re-read the file from disk to get the latest commentHistory (in case of git sync)
        try {
            const latestRaw = fs.readFileSync(filePath, "utf8");
            const latestParsed = matter(latestRaw);
            latestData = latestParsed.data;
        } catch (error) {
            console.warn(`Could not re-read file ${filePath}, using in-memory data:`, error.message);
            latestData = frontmatter;
        }
    }

    // Get existing comment history from the latest file data
    const commentHistory = Array.isArray(latestData.commentHistory) ? [...latestData.commentHistory] : [];
    const existingHashes = new Set();

    // Extract hashes from existing history entries for comparison
    for (const entry of commentHistory) {
        if (typeof entry === 'string') {
            // Extract content from [Date][CreatedBy] format
            const match = entry.match(/\[.*?\]\[.*?\]\s*(.*)/);
            if (match) {
                const content = match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'); // Unescape
                const hash = Buffer.from(content).toString('base64').slice(0, 16);
                existingHashes.add(hash);
            }
        } else if (entry.hash) {
            // Legacy format support
            existingHashes.add(entry.hash);
        }
    }
    let hasNewComments = false;

    // Process each comment
    for (const comment of comments) {
        let commentText = String(comment).trim();
        if (!commentText) continue;

        // Create a simple hash for the ORIGINAL comment (before image processing)
        const originalHash = Buffer.from(commentText).toString('base64').slice(0, 16);

        // Skip if already posted (check against original comment)
        if (existingHashes.has(originalHash)) {
            console.log(`Skipping already posted comment: ${commentText.slice(0, 50)}...`);
            continue;
        }

        try {
            // Process images in the comment
            console.log(`Processing comment: "${commentText}"`);
            const processedCommentText = await processCommentWithImages({
                owner,
                repo,
                commentText,
                baseDir
            });
            console.log(`Processed comment result: "${processedCommentText}"`);

            // Validate the processed comment
            if (processedCommentText.includes('[object Object]')) {
                console.error(`Comment processing failed, contains [object Object]: ${processedCommentText}`);
                console.log(`Using original comment instead: ${commentText}`);
                // Use original comment if processing failed
                var finalCommentText = commentText;
            } else {
                var finalCommentText = processedCommentText;
            }

            // Post the processed comment (with converted image URLs)
            const timestamp = new Date().toISOString();

            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body: finalCommentText
            });

            // Track this comment as posted (store the PROCESSED version in history)
            const dateOnly = timestamp.split('T')[0]; // Extract YYYY-MM-DD
            const createdBy = github.context.actor || "github-actions[bot]"; // Use actual user who triggered the action
            // Escape special characters for YAML safety
            const safeComment = finalCommentText.replace(/"/g, '\\"').replace(/\n/g, '\\n');
            commentHistory.push(`[${dateOnly}][${createdBy}] ${safeComment}`);

            hasNewComments = true;
            console.log(`Posted new comment on issue #${issue_number}: "${finalCommentText.slice(0, 100)}..."`);
        } catch (error) {
            console.warn(`Failed to post comment on issue #${issue_number}:`, error.message);
        }
    }

    // Update comment history
    if (hasNewComments) {
        if (isSubIssue) {
            // For sub-issues, update the frontmatter object directly
            frontmatter.commentHistory = commentHistory;
        } else {
            // For main issues, write back to file with updated comment history
            try {
                // Re-read the file again to ensure we have the absolute latest version
                const currentRaw = fs.readFileSync(filePath, "utf8");
                const currentParsed = matter(currentRaw);
                currentParsed.data.commentHistory = commentHistory;

                fs.writeFileSync(filePath, matter.stringify(currentParsed.content, currentParsed.data));
                console.log(`Updated comment history in ${filePath}`);
            } catch (writeError) {
                console.warn(`Failed to update comment history in ${filePath}:`, writeError.message);
            }
        }
    }

    return hasNewComments;
}

async function upsertComment({ owner, repo, issue_number, header, body }) {
    if (!mdToBool(body)) return;

    try {
        const { data: comments } = await octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number,
            per_page: 100
        });

        const marker = `**${header}**`;
        const existing = comments.find(c => (c.body || "").includes(marker));
        const newBody = `${marker}\n\n${body.trim()}`;

        if (existing) {
            // Only update if content has changed
            if (existing.body !== newBody) {
                await octokit.rest.issues.updateComment({
                    owner,
                    repo,
                    comment_id: existing.id,
                    body: newBody
                });
                console.log(`Updated comment with header "${header}" on issue #${issue_number}`);
            }
        } else {
            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body: newBody
            });
            console.log(`Created comment with header "${header}" on issue #${issue_number}`);
        }
    } catch (error) {
        console.warn(`Failed to upsert comment on issue #${issue_number}:`, error.message);
    }
}

// ---- Move a task file into a subfolder named after its Status ----
function moveFileToStatusFolder(currentPath, statusValue) {
    if (!statusValue) return currentPath; // no status ? leave as-is

    const safeStatus = String(statusValue).trim().replace(/[/\\<>:"|?*]+/g, "_"); // avoid problematic characters

    // Get the Tasks directory (absolute path)
    const tasksDir = path.resolve(TASKS_DIR);
    const targetDir = path.join(tasksDir, safeStatus);

    // Check if we're already in the correct location
    const currentDir = path.dirname(currentPath);
    if (path.resolve(currentDir) === path.resolve(targetDir)) {
        console.log(`File ${path.basename(currentPath)} is already in the correct status folder: ${safeStatus}`);
        return currentPath; // already in the right place
    }

    // Create target directory if it doesn't exist
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        console.log(`Created status directory: ${path.relative(process.cwd(), targetDir)}`);
    } else {
        console.log(`Status directory already exists: ${path.relative(process.cwd(), targetDir)}`);
    }

    const targetPath = path.join(targetDir, path.basename(currentPath));

    // Move the file on disk (rename handles moves)
    if (fs.existsSync(currentPath)) {
        try {
            fs.renameSync(currentPath, targetPath);
            console.log(`Successfully moved file: ${path.relative(process.cwd(), currentPath)} → ${path.relative(process.cwd(), targetPath)}`);
        } catch (error) {
            console.warn(`Failed to move file ${currentPath}:`, error.message);
            return currentPath; // Return original path if move failed
        }
    } else {
        console.warn(`Source file does not exist: ${currentPath}`);
        return currentPath;
    }

    return targetPath;
}

function extractIssueNumber(ref, owner, repo) {
    if (!ref) return null;
    const s = String(ref).trim();
    if (/^#\d+$/.test(s)) return Number(s.slice(1));
    const m = s.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
    if (m && (m[1].toLowerCase() === owner.toLowerCase()) && (m[2].toLowerCase() === repo.toLowerCase()))
        return Number(m[3]);
    return null;
}

const tasksDir = path.resolve(process.env.TASKS_DIR || "Tasks");

// --- Recursive walker that RETURNS RELATIVE PATHS ---
function walkMdFilesRel(dir) {
    const out = [];

    // Check if directory exists
    if (!fs.existsSync(dir)) {
        console.log(`Directory "${dir}" does not exist`);
        return out;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const e of entries) {
        const full = path.join(dir, e.name);

        if (e.isDirectory()) {
            // Recursively walk subdirectories
            out.push(...walkMdFilesRel(full));
        } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
            // store as RELATIVE to TASKS_DIR
            out.push(path.relative(TASKS_DIR, full));
        }
    }
    return out;
}

// Handle deletion of orphaned issues - IMPROVED VERSION
async function handleDeletedFiles(processedIssueNumbers, project, owner, repo) {
    console.log("\n=== Checking for orphaned issues (deleted .md files) ===");

    try {
        // Get all issues from the project
        const projectIssues = await getProjectIssues(project.id);

        // Get all existing .md files to know what SHOULD exist
        const existingMdFiles = walkMdFilesRel(TASKS_DIR);
        const currentIssueNumbers = new Set();

        // Parse existing .md files to get their issue numbers
        for (const relativeFile of existingMdFiles) {
            const filePath = path.resolve(TASKS_DIR, relativeFile);
            try {
                const raw = fs.readFileSync(filePath, "utf8");
                const { data } = matter(raw);
                if (data.issue && typeof data.issue === 'number') {
                    currentIssueNumbers.add(data.issue);
                }
            } catch (error) {
                console.warn(`Error reading ${filePath}: ${error.message}`);
                continue;
            }
        }

        console.log(`Found ${currentIssueNumbers.size} issues in current .md files`);

        // Find issues in project that have sync markers but no corresponding .md file
        const orphanedIssues = projectIssues.filter(item => {
            const issue = item.content;
            if (!issue || !issue.number) return false;

            // Check if this issue has a corresponding .md file
            const hasCorrespondingFile = currentIssueNumbers.has(issue.number);
            if (hasCorrespondingFile) return false;

            // Check if issue has sync markers (either label or body marker)
            const hasLabel = issue.labels && issue.labels.nodes.some(label => label.name === SYNC_LABEL);
            const hasMarker = issue.body && issue.body.includes("<!-- SYNC-MANAGED -->");

            return hasLabel || hasMarker;
        });

        console.log(`Found ${orphanedIssues.length} orphaned issues (sync-managed but no corresponding .md file)`);

        for (const item of orphanedIssues) {
            const issue = item.content;
            console.log(`Processing orphaned issue #${issue.number}: "${issue.title}"`);

            try {
                // Option 1: Close the issue and remove from project
                await octokit.rest.issues.update({
                    owner,
                    repo,
                    issue_number: issue.number,
                    state: 'closed'
                });

                // Add a comment explaining why it was closed
                await octokit.rest.issues.createComment({
                    owner,
                    repo,
                    issue_number: issue.number,
                    body: `🤖 **Auto-closed by sync process**\n\nThis issue was automatically closed because its corresponding markdown file was deleted from the repository.\n\n_If this was a mistake, you can reopen this issue and recreate the markdown file._`
                });

                console.log(`✅ Closed orphaned issue #${issue.number}`);

                // Option 2: Remove from project board (more thorough cleanup)
                try {
                    await octokit.graphql(`
                        mutation($projectId:ID!,$itemId:ID!){
                            deleteProjectV2Item(input:{projectId:$projectId, itemId:$itemId}){
                                deletedItemId
                            }
                        }
                    `, { projectId: project.id, itemId: item.id });
                    console.log(`🗑️  Removed issue #${issue.number} from project board`);
                } catch (removeError) {
                    console.warn(`Failed to remove issue #${issue.number} from project:`, removeError.message);
                }

            } catch (error) {
                console.warn(`❌ Failed to process orphaned issue #${issue.number}:`, error.message);
            }
        }

        if (orphanedIssues.length > 0) {
            console.log(`✅ Processed ${orphanedIssues.length} orphaned issues`);
        } else {
            console.log(`ℹ️  No orphaned issues found`);
        }

    } catch (error) {
        console.error(`❌ Error during orphaned issue cleanup:`, error.message);
        // Don't fail the entire process for this
    }
}

// ---------- MAIN - FIXED VERSION ----------

(async () => {
    const { owner, repo } = repoContext();
    const tasksDir = path.join(process.cwd(), TASKS_DIR);

    // Get project information first - we need this for deletion detection even if no .md files exist
    const project = await getProjectNode();
    const { map: fieldMap } = await getProjectFields(project.id);
    const statusField = fieldMap.get(STATUS_FIELD_NAME);

    // Track which issues have been processed from .md files
    const processedIssueNumbers = new Set();

    // Check if Tasks directory exists and process files if it does
    if (fs.existsSync(tasksDir)) {
        const files = walkMdFilesRel(TASKS_DIR);

        if (files.length > 0) {
            console.log(`Found ${files.length} markdown files to process`);

            for (const file of files) {
                let filePath = path.resolve(tasksDir, file); // Use absolute path

                // Check if file still exists (it might have been moved in a previous iteration)
                if (!fs.existsSync(filePath)) {
                    console.log(`File ${filePath} no longer exists, skipping...`);
                    continue;
                }

                console.log(`Processing file: ${path.relative(process.cwd(), filePath)}`);

                const raw = fs.readFileSync(filePath, "utf8");
                const { data, content } = matter(raw);

                // Ensure the file lives in a folder named after its Status
                if (data.status) {
                    const relocated = moveFileToStatusFolder(filePath, data.status);
                    if (relocated !== filePath) {
                        console.log(`Moved ${path.relative(process.cwd(), filePath)} → ${path.relative(process.cwd(), relocated)} based on status "${data.status}"`);
                        filePath = relocated;

                        // Re-read the file from its new location
                        const relocatedRaw = fs.readFileSync(filePath, "utf8");
                        const relocatedParsed = matter(relocatedRaw);
                        Object.assign(data, relocatedParsed.data); // Update data with any changes from the move
                    }
                }

                const title = (data.title || path.basename(file, ".md")).trim();
                const body = (data.description || content || "").trim();

                // Ensure issue exists (reusing data.issue if present)
                const issue = await findOrCreateIssue({
                    owner, repo, filePath, fmTitle: title, body, existingIssue: data.issue, frontmatterData: data
                });
                console.log(`${issue.created ? "Created" : "Using"} issue #${issue.number} — ${issue.html_url}`);

                // Track this issue as processed
                processedIssueNumbers.add(issue.number);

                // ALWAYS update title and body (even for existing issues) with selective enhancement
                if (!issue.created) {
                    const enhancedBody = enhanceDescriptionSelectively(body, data);
                    const bodyWithMarker = `${enhancedBody}\n\n<!-- SYNC-MANAGED -->`;
                    await updateIssueContent({ owner, repo, issueNumber: issue.number, title, body: bodyWithMarker });
                }

                // Add to project
                const itemId = await addIssueToProject(project.id, issue.node_id);

                // Issue-side sync
                const assignees = Array.isArray(data.assignees) ? data.assignees : [];
                const labels = Array.isArray(data.labels) ? data.labels : [];
                const milestoneTitle = (data.milestone || "").trim();
                await setIssueBasics({ owner, repo, issueNumber: issue.number, assignees, labels, milestoneTitle });

                // Handle sub-issues
                if (Array.isArray(data.subIssues) && data.subIssues.length) {
                    const createdSubIssues = await createSubIssues({
                        owner,
                        repo,
                        parentIssueNumber: issue.number,
                        subIssues: data.subIssues,
                        filePath,
                        project, // Pass project for field updates
                        fieldMap // Pass fieldMap for field updates
                    });

                    // Track sub-issues as processed too
                    createdSubIssues.forEach(subIssue => {
                        processedIssueNumbers.add(subIssue.number);
                    });

                    // Add sub-issue references to relationships comment
                    if (createdSubIssues.length > 0) {
                        const subIssueRefs = createdSubIssues.map(sub => `#${sub.number}`);
                        const existingRels = Array.isArray(data.relationships) ? data.relationships : [];
                        const allRels = [...existingRels, ...subIssueRefs];

                        await upsertComment({
                            owner, repo, issue_number: issue.number,
                            header: RELATIONSHIP_HEADER,
                            body: allRels.map(String).join("\n")
                        });
                    }
                }

                // Relationships: record as a comment list with references (GitHub auto-links)
                if (Array.isArray(data.relationships) && data.relationships.length) {
                    await upsertComment({
                        owner, repo, issue_number: issue.number,
                        header: RELATIONSHIP_HEADER,
                        body: data.relationships.map(String).join("\n")
                    });
                }

                // Handle comments with history system
                if (Array.isArray(data.comments) && data.comments.length) {
                    await handleCommentsWithHistory({
                        owner, repo, issue_number: issue.number,
                        header: COMMENT_HEADER,
                        comments: data.comments,
                        filePath,
                        frontmatter: data
                    });
                }

                // Project fields
                const desired = {
                    [STATUS_FIELD_NAME]: data.status,
                    "Sprint": data.sprint,
                    "Priority": data.priority,
                    "Size": data.size,
                    "Estimate": data.estimate,
                    "Dev Hours": data.devHours,
                    "QA Hours": data.qaHours,
                    "Planned Start": data.plannedStart,
                    "Planned End": data.plannedEnd,
                    "Actual Start": data.actualStart,
                    "Actual End": data.actualEnd
                };

                for (const [name, val] of Object.entries(desired)) {
                    const field = fieldMap.get(name);
                    if (field && mdToBool(val)) {
                        await setFieldValue({ projectId: project.id, itemId, field, value: val });
                        console.log(`Set field ${name} = ${val}`);
                    }
                }
            }
        } else {
            console.log("No md files found in Tasks directory");
        }
    } else {
        console.log("No Tasks directory found - checking for orphaned issues");
    }

    // ALWAYS run deletion detection, regardless of whether Tasks directory exists or has files
    // This is crucial when the entire Tasks directory is deleted or emptied
    await handleDeletedFiles(processedIssueNumbers, project, owner, repo);

    // Commit any frontmatter updates
    if (fs.existsSync(".git")) {
        const { execSync } = require("child_process");
        try {
            // Check if there are any changes to commit
            const gitStatus = execSync("git status --porcelain").toString().trim();
            if (gitStatus) {
                console.log("Git changes detected, attempting to sync with remote...");

                // First, try to pull any remote changes
                try {
                    execSync("git pull --rebase", { stdio: 'pipe' });
                    console.log("Successfully pulled remote changes");
                } catch (pullError) {
                    console.warn("Pull failed, proceeding with local changes:", pullError.message);
                }

                // Configure git user
                execSync('git config user.name "github-actions[bot]"');
                execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');

                // Add and commit changes
                execSync("git add -A");
                execSync('git commit -m "Update issue numbers, sub-issues, comment history and handle deletions"');

                // Push changes
                try {
                    execSync("git push", { stdio: 'pipe' });
                    console.log("Successfully pushed changes");
                } catch (pushError) {
                    console.warn("Push failed:", pushError.message);
                }
            } else {
                console.log("No changes to commit");
            }
        } catch (e) {
            console.warn("Git operation skipped:", e.message);
        }
    }
})().catch(err => core.setFailed(err.message));