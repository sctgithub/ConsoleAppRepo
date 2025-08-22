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

if (!token) { core.setFailed("PROJECTS_TOKEN missing"); process.exit(1); }
if (!OWNER || !PROJECT_NUMBER) { core.setFailed("OWNER/PROJECT_NUMBER missing"); process.exit(1); }

const octokit = github.getOctokit(token);

const mdToBool = v => typeof v === "string" ? v.trim().length > 0 : !!v;

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
    if (labels?.length) await ensureLabels({ owner, repo, labels });
    let milestone = undefined;
    if (milestoneTitle) {
        const m = await octokit.rest.issues.listMilestones({ owner, repo, state: "open" });
        const found = m.data.find(mi => mi.title.toLowerCase() === milestoneTitle.toLowerCase());
        if (found) milestone = found.number;
    }
    await octokit.rest.issues.update({
        owner, repo, issue_number: issueNumber,
        assignees, labels, milestone
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
async function createSubIssues({ owner, repo, parentIssueNumber, subIssues, filePath }) {
    if (!Array.isArray(subIssues) || !subIssues.length) return [];

    const createdSubIssues = [];

    for (const subIssue of subIssues) {
        try {
            // Create the sub-issue
            const created = await octokit.rest.issues.create({
                owner,
                repo,
                title: subIssue.title || "Sub-task",
                body: `${subIssue.description || ""}\n\nParent issue: #${parentIssueNumber}`
            });

            createdSubIssues.push({
                number: created.data.number,
                title: created.data.title,
                url: created.data.html_url
            });

            // Add labels if specified
            if (subIssue.labels && Array.isArray(subIssue.labels)) {
                await ensureLabels({ owner, repo, labels: subIssue.labels });
                await octokit.rest.issues.update({
                    owner,
                    repo,
                    issue_number: created.data.number,
                    labels: subIssue.labels
                });
            }

            console.log(`Created sub-issue #${created.data.number} for parent #${parentIssueNumber}`);
        } catch (error) {
            console.warn(`Failed to create sub-issue for #${parentIssueNumber}:`, error.message);
        }
    }

    // Update the markdown file with the created sub-issue numbers
    if (createdSubIssues.length > 0) {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = matter(raw);

        // Add sub-issue numbers to frontmatter
        parsed.data.subIssues = parsed.data.subIssues.map((subIssue, index) => {
            if (createdSubIssues[index]) {
                return {
                    ...subIssue,
                    issue: createdSubIssues[index].number
                };
            }
            return subIssue;
        });

        fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
    }

    return createdSubIssues;
}

async function findOrCreateIssue({ owner, repo, filePath, fmTitle, body, existingIssue }) {
    if (existingIssue) {
        // Verify it exists
        try {
            const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: existingIssue });
            return { number: data.number, node_id: data.node_id, html_url: data.html_url, created: false };
        } catch { /* fall through to create */ }
    }

    // Try exact-title match to reuse
    const q = `repo:${owner}/${repo} is:issue "${fmTitle.replace(/"/g, '\\"')}" in:title`;
    const search = await octokit.rest.search.issuesAndPullRequests({ q });
    const hit = search.data.items.find(i => i.title === fmTitle && !i.pull_request);
    if (hit) return { number: hit.number, node_id: hit.node_id, html_url: hit.html_url, created: false };

    // Create
    const created = await octokit.rest.issues.create({ owner, repo, title: fmTitle, body });
    // Write back issue number into the md file immediately
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    parsed.data.issue = created.data.number;
    fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
    return { number: created.data.number, node_id: created.data.node_id, html_url: created.data.html_url, created: true };
}

// NEW: Comment History System
async function handleCommentsWithHistory({ owner, repo, issue_number, header, comments, filePath, frontmatter }) {
    if (!Array.isArray(comments) || !comments.length) return false;

    // Always re-read the file from disk to get the latest commentHistory (in case of git sync)
    let latestData;
    try {
        const latestRaw = fs.readFileSync(filePath, "utf8");
        const latestParsed = matter(latestRaw);
        latestData = latestParsed.data;
    } catch (error) {
        console.warn(`Could not re-read file ${filePath}, using in-memory data:`, error.message);
        latestData = frontmatter;
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
        const commentText = String(comment).trim();
        if (!commentText) continue;

        // Create a simple hash for the comment
        const hash = Buffer.from(commentText).toString('base64').slice(0, 16);

        // Skip if already posted
        if (existingHashes.has(hash)) {
            console.log(`Skipping already posted comment: ${commentText.slice(0, 50)}...`);
            continue;
        }

        try {
            // Post the comment
            const timestamp = new Date().toISOString();
            const body = commentText;

            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body
            });

            // Track this comment as posted
            const dateOnly = timestamp.split('T')[0]; // Extract YYYY-MM-DD
            const createdBy = github.context.actor || "github-actions[bot]"; // Use actual user who triggered the action
            // Escape special characters for YAML safety
            const safeComment = commentText.replace(/"/g, '\\"').replace(/\n/g, '\\n');
            commentHistory.push(`[${dateOnly}][${createdBy}] ${safeComment}`);

            hasNewComments = true;
            console.log(`Posted new comment on issue #${issue_number}`);
        } catch (error) {
            console.warn(`Failed to post comment on issue #${issue_number}:`, error.message);
        }
    }

    // Update frontmatter with comment history if there were new comments
    if (hasNewComments) {
        // Write back to file with updated comment history
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
    const baseDir = path.dirname(path.dirname(currentPath)); // Get the parent of Tasks dir
    const targetDir = path.join(baseDir, TASKS_DIR, safeStatus);

    // Create target directory if it doesn't exist
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        console.log(`Created directory: ${targetDir}`);
    }

    const targetPath = path.join(targetDir, path.basename(currentPath));
    if (currentPath === targetPath) return currentPath; // already in the right place

    // Move the file on disk (rename handles moves)
    if (fs.existsSync(currentPath)) {
        try {
            fs.renameSync(currentPath, targetPath);
            console.log(`Successfully moved file to status folder: ${path.basename(currentPath)} → ${safeStatus}/`);
        } catch (error) {
            console.warn(`Failed to move file ${currentPath}:`, error.message);
            return currentPath; // Return original path if move failed
        }
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
        console.log(e.name);
        const full = path.join(dir, e.name);

        if (e.isDirectory()) {
            out.push(...walkMdFilesRel(full));
        } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
            // store as RELATIVE to TASKS_DIR
            out.push(path.relative(TASKS_DIR, full));
        }
    }
    return out;
}

// ---------- MAIN ----------

(async () => {
    const { owner, repo } = repoContext();
    const tasksDir = path.join(process.cwd(), TASKS_DIR);
    if (!fs.existsSync(tasksDir)) { console.log("No tasks dir"); return; }

    const files = walkMdFilesRel(TASKS_DIR);
    if (!files.length) {
        console.log("No md files");
        return;
    }

    const project = await getProjectNode();
    const { map: fieldMap } = await getProjectFields(project.id);
    const statusField = fieldMap.get(STATUS_FIELD_NAME);

    for (const file of files) {
        let filePath = path.join(tasksDir, file);
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
            owner, repo, filePath, fmTitle: title, body, existingIssue: data.issue
        });
        console.log(`${issue.created ? "Created" : "Using"} issue #${issue.number} – ${issue.html_url}`);

        // ALWAYS update title and body (even for existing issues)
        if (!issue.created) {
            await updateIssueContent({ owner, repo, issueNumber: issue.number, title, body });
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
                filePath
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

        // NEW: Handle comments with history system
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
                execSync('git commit -m "Update issue numbers, sub-issues, and comment history in Markdown files"');

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