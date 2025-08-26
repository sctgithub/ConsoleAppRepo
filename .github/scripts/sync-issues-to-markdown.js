const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const core = require("@actions/core");
const github = require("@actions/github");
const https = require('https');

const token = process.env.PROJECTS_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = process.env.OWNER;
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER);
const STATUS_FIELD_NAME = process.env.STATUS_FIELD_NAME || "Status";
const TASKS_DIR = process.env.TASKS_DIR || "Tasks";
const IMAGES_DIR = path.join(TASKS_DIR, "Images");

if (!token) { core.setFailed("PROJECTS_TOKEN missing"); process.exit(1); }
if (!OWNER || !PROJECT_NUMBER) { core.setFailed("OWNER/PROJECT_NUMBER missing"); process.exit(1); }

const octokit = github.getOctokit(token);

// Create directories if they don't exist
function ensureDirectories() {
    if (!fs.existsSync(TASKS_DIR)) {
        fs.mkdirSync(TASKS_DIR, { recursive: true });
    }
    if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
    }
}

// Download image from URL and save to Images folder
async function downloadImage(imageUrl, fileName) {
    return new Promise((resolve, reject) => {
        const filePath = path.join(IMAGES_DIR, fileName);

        // Check if file already exists
        if (fs.existsSync(filePath)) {
            console.log(`Image already exists: ${fileName}`);
            resolve(path.relative(TASKS_DIR, filePath));
            return;
        }

        const file = fs.createWriteStream(filePath);

        https.get(imageUrl, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download image: ${response.statusCode}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                console.log(`Downloaded image: ${fileName}`);
                resolve(path.relative(TASKS_DIR, filePath));
            });
        }).on('error', (err) => {
            fs.unlink(filePath, () => { }); // Delete partial file
            reject(err);
        });
    });
}

// Process issue body and download images, convert to local references
async function processIssueBody(body) {
    if (!body) return "";

    // Find all image references in markdown format
    const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
    let processedBody = body;
    let match;

    while ((match = imageRegex.exec(body)) !== null) {
        const [fullMatch, altText, imageUrl] = match;

        try {
            // Extract filename from URL or generate one
            let fileName = path.basename(imageUrl.split('?')[0]);
            if (!fileName.match(/\.(jpg|jpeg|png|gif|svg|webp)$/i)) {
                fileName = `image_${Date.now()}.png`;
            }

            // Download image and get relative path
            const relativePath = await downloadImage(imageUrl, fileName);

            // Replace with local reference using [IMAGE:path] format
            const localReference = `[IMAGE:${relativePath}]`;
            processedBody = processedBody.replace(fullMatch, `${altText ? altText + ': ' : ''}${localReference}`);

        } catch (error) {
            console.warn(`Failed to download image ${imageUrl}: ${error.message}`);
        }
    }

    return processedBody;
}

// Get project fields and create field mapping
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
    return res.node.fields.nodes;
}

// Get project node
async function getProjectNode() {
    const orgQ = `query($login:String!,$number:Int!){ organization(login:$login){ projectV2(number:$number){ id title }}}`;
    const userQ = `query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id title }}}`;
    const asOrg = await octokit.graphql(orgQ, { login: OWNER, number: PROJECT_NUMBER }).catch(() => null);
    if (asOrg?.organization?.projectV2) return asOrg.organization.projectV2;
    const asUser = await octokit.graphql(userQ, { login: OWNER, number: PROJECT_NUMBER }).catch(() => null);
    if (asUser?.user?.projectV2) return asUser.user.projectV2;
    throw new Error(`Project v2 #${PROJECT_NUMBER} not found for ${OWNER}`);
}

// Get all issues from the project
async function getProjectIssues(projectId) {
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
              fieldValues(first:50) {
                nodes {
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldNumberValue {
                    number
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldDateValue {
                    date
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                  }
                }
              }
              content {
                ... on Issue {
                  id
                  number
                  title
                  body
                  state
                  assignees(first:10) {
                    nodes {
                      login
                    }
                  }
                  labels(first:20) {
                    nodes {
                      name
                    }
                  }
                  milestone {
                    title
                  }
                  createdAt
                  updatedAt
                  comments(first:100) {
                    nodes {
                      body
                      createdAt
                      author {
                        login
                      }
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
        const issues = items.nodes.filter(item =>
            item.content &&
            item.content.number &&
            item.content.title
        );

        allIssues.push(...issues);

        hasNextPage = items.pageInfo.hasNextPage;
        cursor = items.pageInfo.endCursor;
    }

    return allIssues;
}

// Find existing markdown file for an issue number
function findExistingMarkdownFile(issueNumber) {
    const searchDirs = [TASKS_DIR];

    // Add subdirectories to search
    if (fs.existsSync(TASKS_DIR)) {
        const entries = fs.readdirSync(TASKS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                searchDirs.push(path.join(TASKS_DIR, entry.name));
            }
        }
    }

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const parsed = matter(content);
                if (parsed.data.issue === issueNumber) {
                    return filePath;
                }
            } catch (error) {
                continue; // Skip files that can't be parsed
            }
        }
    }

    return null;
}

// Create or update markdown file for an issue
async function createMarkdownFile(issue, projectFields) {
    const issueData = issue.content;
    const fieldValues = issue.fieldValues.nodes;

    // Build field mapping
    const fieldMap = {};
    for (const fieldValue of fieldValues) {
        if (fieldValue.field && fieldValue.field.name) {
            if (fieldValue.text !== undefined) fieldMap[fieldValue.field.name] = fieldValue.text;
            else if (fieldValue.number !== undefined) fieldMap[fieldValue.field.name] = fieldValue.number;
            else if (fieldValue.date !== undefined) fieldMap[fieldValue.field.name] = fieldValue.date;
            else if (fieldValue.name !== undefined) fieldMap[fieldValue.field.name] = fieldValue.name;
        }
    }

    // Process body for images
    const processedBody = await processIssueBody(issueData.body);

    // Process comments for history tracking
    const allComments = issueData.comments.nodes
        .filter(comment => !comment.body.includes("**Relationships**") &&
            !comment.body.includes("**Automated Notes**"))
        .map(comment => ({
            body: comment.body,
            createdAt: comment.createdAt,
            author: comment.author?.login || "unknown"
        }));

    // Create comment history entries in the format used by the populate script
    const commentHistory = allComments.map(comment => {
        const dateOnly = comment.createdAt.split('T')[0]; // Extract YYYY-MM-DD
        const safeComment = comment.body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
        return `[${dateOnly}][${comment.author}] ${safeComment}`;
    });

    // Build frontmatter
    const frontmatter = {
        title: issueData.title,
        description: processedBody,
        issue: issueData.number,
        status: fieldMap[STATUS_FIELD_NAME] || null,
        size: fieldMap["Size"] || null,
        estimate: fieldMap["Estimate"] || null,
        devHours: fieldMap["Dev Hours"] || null,
        qaHours: fieldMap["QA Hours"] || null,
        plannedStart: fieldMap["Planned Start"] || null,
        plannedEnd: fieldMap["Planned End"] || null,
        actualStart: fieldMap["Actual Start"] || null,
        actualEnd: fieldMap["Actual End"] || null,
        assignees: issueData.assignees.nodes.map(a => a.login),
        labels: issueData.labels.nodes.map(l => l.name),
        priority: fieldMap["Priority"] || null,
        sprint: fieldMap["Sprint"] || null,
        milestone: issueData.milestone?.title || null,
        relationships: [], // This would need more complex parsing
        comments: [], // Leave empty - all comments go to commentHistory
        commentHistory: commentHistory
    };

    // Remove null values
    Object.keys(frontmatter).forEach(key => {
        if (frontmatter[key] === null ||
            (Array.isArray(frontmatter[key]) && frontmatter[key].length === 0)) {
            delete frontmatter[key];
        }
    });

    // Try to find existing file first
    let filePath = findExistingMarkdownFile(issueData.number);
    let isExistingFile = !!filePath;

    if (filePath) {
        // Check if existing file needs updating
        const existingRaw = fs.readFileSync(filePath, "utf8");
        const existingParsed = matter(existingRaw);

        // Preserve existing commentHistory and relationships from local file
        if (existingParsed.data.commentHistory) {
            // Merge existing comment history with new comments from GitHub
            const existingHistory = Array.isArray(existingParsed.data.commentHistory) ?
                existingParsed.data.commentHistory : [];

            // Create a set of existing comment content to avoid duplicates
            const existingCommentContent = new Set();
            for (const entry of existingHistory) {
                if (typeof entry === 'string') {
                    const match = entry.match(/\[.*?\]\[.*?\]\s*(.*)/);
                    if (match) {
                        const content = match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
                        existingCommentContent.add(content);
                    }
                }
            }

            // Only add new comments that aren't already in history
            const newComments = commentHistory.filter(entry => {
                const match = entry.match(/\[.*?\]\[.*?\]\s*(.*)/);
                if (match) {
                    const content = match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
                    return !existingCommentContent.has(content);
                }
                return true;
            });

            // Combine existing and new
            frontmatter.commentHistory = [...existingHistory, ...newComments];
        }

        if (existingParsed.data.relationships) {
            frontmatter.relationships = existingParsed.data.relationships;
        }

        // Preserve any pending comments in the comments array (not yet posted)
        if (existingParsed.data.comments && Array.isArray(existingParsed.data.comments)) {
            frontmatter.comments = existingParsed.data.comments;
        }

        // Compare key fields to see if update is needed
        const needsUpdate =
            existingParsed.data.title !== frontmatter.title ||
            existingParsed.data.description !== frontmatter.description ||
            existingParsed.data.status !== frontmatter.status ||
            JSON.stringify(existingParsed.data.assignees) !== JSON.stringify(frontmatter.assignees) ||
            JSON.stringify(existingParsed.data.labels) !== JSON.stringify(frontmatter.labels);

        if (!needsUpdate) {
            console.log(`No changes needed for issue #${issueData.number} (${path.basename(filePath)})`);
            return false;
        }

        // Check if file needs to be moved due to status change
        if (frontmatter.status && existingParsed.data.status !== frontmatter.status) {
            const safeStatus = String(frontmatter.status).trim().replace(/[/\\<>:"|?*]+/g, "_");
            const newDir = path.join(TASKS_DIR, safeStatus);
            const newPath = path.join(newDir, path.basename(filePath));

            if (path.dirname(filePath) !== newDir) {
                if (!fs.existsSync(newDir)) {
                    fs.mkdirSync(newDir, { recursive: true });
                }

                // Move the file
                fs.renameSync(filePath, newPath);
                filePath = newPath;
                console.log(`Moved file to new status folder: ${path.relative(process.cwd(), filePath)}`);
            }
        }

    } else {
        // Create new file - only do this for issues that don't have existing markdown files
        console.log(`Creating new markdown file for issue #${issueData.number} (no existing file found)`);

        // Generate filename based on your naming pattern
        const safeTitle = issueData.title
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .toLowerCase()
            .substring(0, 30);
        const filename = `${safeTitle}.md`;

        // Determine folder based on status
        let targetDir = TASKS_DIR;
        if (frontmatter.status) {
            const safeStatus = String(frontmatter.status).trim().replace(/[/\\<>:"|?*]+/g, "_");
            targetDir = path.join(TASKS_DIR, safeStatus);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
        }

        filePath = path.join(targetDir, filename);

        // Ensure unique filename if conflict
        let counter = 1;
        while (fs.existsSync(filePath)) {
            const name = path.parse(filename).name;
            const ext = path.parse(filename).ext;
            filePath = path.join(targetDir, `${name}-${counter}${ext}`);
            counter++;
        }
    }

    // Create markdown content
    const content = "";  // Main content goes in description
    const markdownContent = matter.stringify(content, frontmatter);

    // Write file
    fs.writeFileSync(filePath, markdownContent);
    console.log(`${isExistingFile ? 'Updated' : 'Created'} markdown file: ${path.relative(process.cwd(), filePath)}`);

    return true;
}

// Main sync function
async function syncIssuesFromGitHub() {
    console.log("Starting GitHub issues sync...");

    ensureDirectories();

    try {
        // Get project and its issues
        const project = await getProjectNode();
        const projectFields = await getProjectFields(project.id);
        const projectIssues = await getProjectIssues(project.id);

        console.log(`Found ${projectIssues.length} issues in project`);

        let updatedCount = 0;

        // Process each issue
        for (const issue of projectIssues) {
            if (!issue.content || issue.content.state === 'CLOSED') {
                continue; // Skip closed issues or invalid items
            }

            try {
                const wasUpdated = await createMarkdownFile(issue, projectFields);
                if (wasUpdated) updatedCount++;
            } catch (error) {
                console.warn(`Failed to process issue #${issue.content.number}: ${error.message}`);
            }
        }

        console.log(`Sync completed. ${updatedCount} files updated.`);

        return updatedCount;

    } catch (error) {
        console.error("Sync failed:", error.message);
        throw error;
    }
}

// Run the sync
(async () => {
    try {
        await syncIssuesFromGitHub();
    } catch (error) {
        core.setFailed(`Sync failed: ${error.message}`);
    }
})();