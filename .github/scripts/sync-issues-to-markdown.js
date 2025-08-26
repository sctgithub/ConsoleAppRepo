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

    // Extract comments (excluding automated ones)
    const comments = issueData.comments.nodes
        .filter(comment => !comment.body.includes("**Relationships**") &&
            !comment.body.includes("**Automated Notes**"))
        .map(comment => comment.body);

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
        comments: comments,
        commentHistory: []
    };

    // Remove null values
    Object.keys(frontmatter).forEach(key => {
        if (frontmatter[key] === null ||
            (Array.isArray(frontmatter[key]) && frontmatter[key].length === 0)) {
            delete frontmatter[key];
        }
    });

    // Generate filename
    const safeTitle = issueData.title
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .substring(0, 50);
    const filename = `${issueData.number}-${safeTitle}.md`;

    // Determine folder based on status
    let targetDir = TASKS_DIR;
    if (frontmatter.status) {
        const safeStatus = String(frontmatter.status).trim().replace(/[/\\<>:"|?*]+/g, "_");
        targetDir = path.join(TASKS_DIR, safeStatus);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
    }

    const filePath = path.join(targetDir, filename);

    // Check if file already exists and compare
    if (fs.existsSync(filePath)) {
        const existingRaw = fs.readFileSync(filePath, "utf8");
        const existingParsed = matter(existingRaw);

        // Compare key fields to see if update is needed
        const needsUpdate =
            existingParsed.data.title !== frontmatter.title ||
            existingParsed.data.description !== frontmatter.description ||
            existingParsed.data.status !== frontmatter.status ||
            JSON.stringify(existingParsed.data.assignees) !== JSON.stringify(frontmatter.assignees) ||
            JSON.stringify(existingParsed.data.labels) !== JSON.stringify(frontmatter.labels);

        if (!needsUpdate) {
            console.log(`No changes needed for issue #${issueData.number}`);
            return false;
        }

        // Preserve existing commentHistory
        if (existingParsed.data.commentHistory) {
            frontmatter.commentHistory = existingParsed.data.commentHistory;
        }
    }

    // Create markdown content
    const content = "";  // Main content goes in description
    const markdownContent = matter.stringify(content, frontmatter);

    // Write file
    fs.writeFileSync(filePath, markdownContent);
    console.log(`${fs.existsSync(filePath) ? 'Updated' : 'Created'} markdown file: ${path.relative(process.cwd(), filePath)}`);

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