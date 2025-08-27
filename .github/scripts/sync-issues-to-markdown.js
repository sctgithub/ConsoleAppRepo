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
        console.log(`Created directory: ${TASKS_DIR}`);
    }
    if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
        console.log(`Created directory: ${IMAGES_DIR}`);
    }
}

// Download image from URL and save to Images folder
async function downloadImage(imageUrl, fileName) {
    return new Promise((resolve, reject) => {
        const filePath = path.join(IMAGES_DIR, fileName);

        console.log(`Checking for existing image: ${filePath}`);

        // Check if file already exists
        if (fs.existsSync(filePath)) {
            console.log(`Image already exists, skipping download: ${fileName}`);
            resolve(path.relative(TASKS_DIR, filePath));
            return;
        }

        console.log(`Downloading new image: ${imageUrl} -> ${filePath}`);
        const file = fs.createWriteStream(filePath);

        // Handle both http and https URLs
        const client = imageUrl.startsWith('https:') ? require('https') : require('http');

        const request = client.get(imageUrl, (response) => {
            console.log(`Download response status: ${response.statusCode} for ${imageUrl}`);

            if (response.statusCode === 302 || response.statusCode === 301) {
                // Handle redirects
                file.close();
                fs.unlink(filePath, () => { });
                return downloadImage(response.headers.location, fileName)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(filePath, () => { });
                reject(new Error(`Failed to download image: ${response.statusCode} - ${response.statusMessage}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                console.log(`Successfully downloaded image: ${fileName}`);
                resolve(path.relative(TASKS_DIR, filePath));
            });

            file.on('error', (err) => {
                file.close();
                fs.unlink(filePath, () => { });
                reject(err);
            });
        });

        request.on('error', (err) => {
            file.close();
            fs.unlink(filePath, () => { });
            reject(err);
        });

        request.setTimeout(30000, () => {
            request.abort();
            file.close();
            fs.unlink(filePath, () => { });
            reject(new Error('Download timeout'));
        });
    });
}

async function processIssueBody(body) {
    if (!body) {
        console.log("Issue body is empty, returning empty string");
        return "";
    }

    console.log(`Processing issue body (${body.length} chars): ${body.substring(0, 200)}...`);

    // Find both markdown and HTML image references
    let processedBody = body;
    const imageMatches = [];

    // Reset regex lastIndex to avoid issues with global regex
    const markdownImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
    const htmlImageRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

    // Find markdown images
    let match;
    markdownImageRegex.lastIndex = 0; // Reset regex
    while ((match = markdownImageRegex.exec(body)) !== null) {
        imageMatches.push({
            fullMatch: match[0],
            altText: match[1] || 'Image',
            imageUrl: match[2],
            type: 'markdown'
        });
    }

    // Reset regex for HTML search
    htmlImageRegex.lastIndex = 0;

    // Find HTML images
    while ((match = htmlImageRegex.exec(body)) !== null) {
        const altMatch = match[0].match(/alt=["']([^"']*)["']/i);
        const altText = altMatch ? altMatch[1] : 'Image';

        imageMatches.push({
            fullMatch: match[0],
            altText: altText,
            imageUrl: match[1],
            type: 'html'
        });
    }

    console.log(`Found ${imageMatches.length} images in issue body`);

    // Log all found images
    imageMatches.forEach((img, index) => {
        console.log(`Image ${index + 1}: ${img.type} - ${img.imageUrl}`);
    });

    // Process each image
    for (let i = 0; i < imageMatches.length; i++) {
        const { fullMatch, altText, imageUrl, type } = imageMatches[i];

        try {
            console.log(`Processing ${type} image ${i + 1}/${imageMatches.length}: ${imageUrl}`);

            // Skip if it's already a GitHub raw URL from our own repo
            if (imageUrl.includes('raw.githubusercontent.com') && imageUrl.includes('images/uploads/')) {
                console.log('Image is already from our repo, converting to local reference');
                const fileName = path.basename(imageUrl);
                const localReference = `[IMAGE:Images/${fileName}]`;
                processedBody = processedBody.replace(fullMatch, `${altText}: ${localReference}`);
                continue;
            }

            // Generate a more unique filename with timestamp and random element
            const timestamp = Date.now();
            const random = Math.random().toString(36).substring(2, 6);
            const urlHash = Buffer.from(imageUrl).toString('hex').substring(0, 8);

            let fileName = path.basename(imageUrl.split('?')[0].split('#')[0]);

            if (!fileName || !fileName.match(/\.(jpg|jpeg|png|gif|svg|webp)$/i)) {
                fileName = `github_image_${timestamp}_${random}_${urlHash}.png`;
            } else {
                const ext = path.extname(fileName);
                const name = path.basename(fileName, ext);
                fileName = `${name}_${timestamp}_${random}${ext}`;
            }

            console.log(`Generated unique filename: ${fileName}`);

            // Download image and get relative path
            const relativePath = await downloadImage(imageUrl, fileName);

            // Replace with local reference using [IMAGE:path] format
            const localReference = `[IMAGE:${relativePath}]`;
            processedBody = processedBody.replace(fullMatch, `${altText}: ${localReference}`);

            console.log(`Successfully processed image ${i + 1}: ${localReference}`);

        } catch (error) {
            console.warn(`Failed to process image ${i + 1} (${imageUrl}): ${error.message}`);
            console.warn(`Error stack: ${error.stack}`);
        }
    }

    console.log(`Final processed body length: ${processedBody.length} chars`);
    return processedBody;
}

// Process GitHub comment and download images
async function processGitHubComment(commentBody) {
    if (!commentBody) return "";

    console.log(`Processing GitHub comment: ${commentBody.substring(0, 100)}...`);

    // Find both markdown and HTML image references
    const markdownImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
    const htmlImageRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

    let processedComment = commentBody;
    const imageMatches = [];

    // Find markdown images
    let match;
    markdownImageRegex.lastIndex = 0; // Reset regex
    while ((match = markdownImageRegex.exec(commentBody)) !== null) {
        imageMatches.push({
            fullMatch: match[0],
            altText: match[1],
            imageUrl: match[2],
            type: 'markdown'
        });
    }

    // Find HTML images
    htmlImageRegex.lastIndex = 0; // Reset regex
    while ((match = htmlImageRegex.exec(commentBody)) !== null) {
        // Extract alt text from the img tag
        const altMatch = match[0].match(/alt=["']([^"']*)["']/i);
        const altText = altMatch ? altMatch[1] : 'Image';

        imageMatches.push({
            fullMatch: match[0],
            altText: altText,
            imageUrl: match[1],
            type: 'html'
        });
    }

    console.log(`Found ${imageMatches.length} images in comment (markdown + HTML)`);

    for (const imageMatch of imageMatches) {
        const { fullMatch, altText, imageUrl, type } = imageMatch;

        try {
            console.log(`Processing ${type} image URL: ${imageUrl}`);

            // Skip if it's already a GitHub raw URL from our own repo
            if (imageUrl.includes('raw.githubusercontent.com') && imageUrl.includes('images/uploads/')) {
                console.log('Image is already from our repo, converting to local reference');
                const fileName = path.basename(imageUrl);
                const localReference = `[IMAGE:Images/${fileName}]`;
                processedComment = processedComment.replace(fullMatch, `${altText ? altText + ': ' : ''}${localReference}`);
                continue;
            }

            // Check if this comment already contains a local image reference for this image
            if (processedComment.includes('[IMAGE:Images/')) {
                console.log('Comment already contains local image reference, skipping');
                continue;
            }

            // Generate a deterministic filename based on the URL to avoid duplicates
            const urlHash = Buffer.from(imageUrl).toString('base64').replace(/[+/=]/g, '').substring(0, 8);
            let fileName = path.basename(imageUrl.split('?')[0]);

            if (!fileName.match(/\.(jpg|jpeg|png|gif|svg|webp)$/i)) {
                fileName = `github_image_${urlHash}.png`;
            } else {
                const ext = path.extname(fileName);
                const name = path.basename(fileName, ext);
                fileName = `${name}_${urlHash}${ext}`;
            }

            console.log(`Using filename: ${fileName}`);

            // Download image and get relative path
            const relativePath = await downloadImage(imageUrl, fileName);

            // Replace with local reference using [IMAGE:path] format
            const localReference = `[IMAGE:${relativePath}]`;
            processedComment = processedComment.replace(fullMatch, `${altText ? altText + ': ' : ''}${localReference}`);

            console.log(`Successfully processed ${type} image: ${imageUrl} -> ${localReference}`);

        } catch (error) {
            console.warn(`Failed to download comment image ${imageUrl}: ${error.message}`);
            console.warn('Stack trace:', error.stack);
            // Keep original if download fails
        }
    }

    return processedComment;
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
    console.log(`Looking for project #${PROJECT_NUMBER} for owner: ${OWNER}`);
    const orgQ = `query($login:String!,$number:Int!){ organization(login:$login){ projectV2(number:$number){ id title }}}`;
    const userQ = `query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id title }}}`;

    try {
        const asOrg = await octokit.graphql(orgQ, { login: OWNER, number: PROJECT_NUMBER });
        if (asOrg?.organization?.projectV2) {
            console.log(`Found project as organization: ${asOrg.organization.projectV2.title}`);
            return asOrg.organization.projectV2;
        }
    } catch (error) {
        console.log(`Not found as organization, trying as user...`);
    }

    try {
        const asUser = await octokit.graphql(userQ, { login: OWNER, number: PROJECT_NUMBER });
        if (asUser?.user?.projectV2) {
            console.log(`Found project as user: ${asUser.user.projectV2.title}`);
            return asUser.user.projectV2;
        }
    } catch (error) {
        console.log(`Not found as user either`);
    }

    throw new Error(`Project v2 #${PROJECT_NUMBER} not found for ${OWNER}`);
}

// Get all issues from the project
async function getProjectIssues(projectId) {
    console.log(`Fetching issues from project ID: ${projectId}`);

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
        console.log(`Fetching issues batch${cursor ? ' after cursor: ' + cursor : ' (first batch)'}...`);
        const result = await octokit.graphql(query, { projectId, cursor });
        const items = result.node.items;

        console.log(`Received ${items.nodes.length} items in this batch`);

        // Filter for issues only (exclude draft issues and PRs)
        const issues = items.nodes.filter(item => {
            const isValid = item.content &&
                item.content.number &&
                item.content.title;

            if (!isValid) {
                console.log(`Skipping invalid item (no content or missing fields):`,
                    item.content ? `Issue #${item.content.number}` : 'Draft/Unknown');
            }

            return isValid;
        });

        console.log(`${issues.length} valid issues found in this batch`);

        // Log issue details
        issues.forEach(issue => {
            console.log(`- Issue #${issue.content.number}: "${issue.content.title}" (State: ${issue.content.state})`);
        });

        allIssues.push(...issues);

        hasNextPage = items.pageInfo.hasNextPage;
        cursor = items.pageInfo.endCursor;

        if (hasNextPage) {
            console.log(`More pages available, continuing...`);
        }
    }

    console.log(`Total issues found across all batches: ${allIssues.length}`);
    return allIssues;
}

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
            out.push(path.relative(dir === TASKS_DIR ? TASKS_DIR : TASKS_DIR, full));
        }
    }
    return out;
}

// Find existing markdown file for an issue number
function findExistingMarkdownFile(issueNumber) {
    console.log(`Searching for existing markdown file for issue #${issueNumber}`);

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

    console.log(`Searching in directories: ${searchDirs.join(', ')}`);

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) {
            console.log(`Directory doesn't exist, skipping: ${dir}`);
            continue;
        }

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
        console.log(`Found ${files.length} .md files in ${dir}`);

        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const parsed = matter(content);
                if (parsed.data.issue === issueNumber) {
                    console.log(`Found existing file for issue #${issueNumber}: ${filePath}`);
                    return filePath;
                }
            } catch (error) {
                console.log(`Error parsing ${filePath}: ${error.message}`);
                continue; // Skip files that can't be parsed
            }
        }
    }

    console.log(`No existing file found for issue #${issueNumber}`);
    return null;
}

// Delete associated images for a markdown file
function deleteAssociatedImages(filePath, issueNumber) {
    try {
        const fileDir = path.dirname(filePath);
        const baseName = path.basename(filePath, '.md');
        const imagesDeleted = [];

        // Look for images in the same directory and Images directory
        const searchDirs = [fileDir, IMAGES_DIR];

        for (const searchDir of searchDirs) {
            if (!fs.existsSync(searchDir)) continue;

            const files = fs.readdirSync(searchDir);

            for (const file of files) {
                const fullPath = path.join(searchDir, file);

                // Check if it's an image file
                if (!/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(file)) continue;

                // Check if image is associated with this issue
                // Look for patterns like: baseName_*, issue-123_*, etc.
                const associatedPatterns = [
                    new RegExp(`^${baseName}[_-]`, 'i'),
                    new RegExp(`issue[_-]?${issueNumber}[_-]`, 'i'),
                    new RegExp(`${issueNumber}[_-]`, 'i')
                ];

                const isAssociated = associatedPatterns.some(pattern => pattern.test(file));

                if (isAssociated) {
                    try {
                        fs.unlinkSync(fullPath);
                        imagesDeleted.push(file);
                        console.log(`Deleted associated image: ${file}`);
                    } catch (error) {
                        console.warn(`Failed to delete image ${file}: ${error.message}`);
                    }
                }
            }
        }

        return imagesDeleted;

    } catch (error) {
        console.warn(`Error while searching for associated images: ${error.message}`);
        return [];
    }
}

// Handle deletion detection from GitHub side
async function handleGitHubSideDeletions(projectIssues) {
    console.log("\n=== Checking for GitHub-side deletions ===");

    try {
        // Get all existing .md files with their issue numbers
        const existingMdFiles = walkMdFilesRel(TASKS_DIR);
        const existingIssueFiles = new Map(); // issueNumber -> filePath

        console.log(`Found ${existingMdFiles.length} existing .md files`);

        for (const relativeFile of existingMdFiles) {
            const filePath = path.resolve(TASKS_DIR, relativeFile);

            try {
                const raw = fs.readFileSync(filePath, "utf8");
                const { data } = matter(raw);

                if (data.issue && typeof data.issue === 'number') {
                    existingIssueFiles.set(data.issue, filePath);
                }
            } catch (error) {
                console.warn(`Error reading ${filePath}: ${error.message}`);
                continue;
            }
        }

        console.log(`Found ${existingIssueFiles.size} .md files with issue numbers`);

        // Get current project issue numbers (open issues only)
        const projectIssueNumbers = new Set(
            projectIssues
                .filter(item => item.content && item.content.state === 'OPEN')
                .map(item => item.content.number)
        );

        console.log(`Found ${projectIssueNumbers.size} open issues in project`);

        // Find .md files that no longer have corresponding GitHub issues in the project
        const orphanedFiles = [];

        for (const [issueNumber, filePath] of existingIssueFiles) {
            if (!projectIssueNumbers.has(issueNumber)) {
                // Double-check if the issue still exists in GitHub (maybe closed or removed from project)
                try {
                    const { owner, repo } = github.context.repo;
                    const issue = await octokit.rest.issues.get({
                        owner,
                        repo,
                        issue_number: issueNumber
                    });

                    if (issue.data.state === 'CLOSED') {
                        orphanedFiles.push({
                            filePath,
                            issueNumber,
                            reason: 'closed'
                        });
                    } else {
                        orphanedFiles.push({
                            filePath,
                            issueNumber,
                            reason: 'removed-from-project'
                        });
                    }
                } catch (error) {
                    if (error.status === 404) {
                        orphanedFiles.push({
                            filePath,
                            issueNumber,
                            reason: 'deleted'
                        });
                    } else {
                        console.warn(`Error checking issue #${issueNumber}: ${error.message}`);
                    }
                }
            }
        }

        console.log(`Found ${orphanedFiles.length} orphaned .md files`);

        // Handle orphaned files
        for (const { filePath, issueNumber, reason } of orphanedFiles) {
            console.log(`Processing orphaned file: ${path.relative(process.cwd(), filePath)} (Issue #${issueNumber} - ${reason})`);

            try {
                // Delete associated images first
                const deletedImages = deleteAssociatedImages(filePath, issueNumber);
                if (deletedImages.length > 0) {
                    console.log(`Deleted ${deletedImages.length} associated images for issue #${issueNumber}`);
                }

                // Delete the markdown file
                fs.unlinkSync(filePath);
                console.log(`Deleted orphaned .md file: ${path.relative(process.cwd(), filePath)}`);

                // Also try to clean up empty directories
                const parentDir = path.dirname(filePath);
                if (parentDir !== TASKS_DIR) {
                    try {
                        const remainingFiles = fs.readdirSync(parentDir);
                        if (remainingFiles.length === 0) {
                            fs.rmdirSync(parentDir);
                            console.log(`Removed empty directory: ${path.relative(process.cwd(), parentDir)}`);
                        }
                    } catch (error) {
                        // Directory not empty or other error, ignore
                    }
                }

            } catch (error) {
                console.warn(`Failed to delete orphaned file ${filePath}: ${error.message}`);
            }
        }

        if (orphanedFiles.length > 0) {
            console.log(`Processed ${orphanedFiles.length} orphaned files`);
            return true; // Indicate that changes were made
        } else {
            console.log(`No orphaned files found`);
            return false;
        }

    } catch (error) {
        console.error(`Error during GitHub-side deletion detection: ${error.message}`);
        return false;
    }
}

// Create or update markdown file for an issue
async function createMarkdownFile(issue, projectFields) {
    const issueData = issue.content;
    const fieldValues = issue.fieldValues.nodes;

    console.log(`\n=== Processing Issue #${issueData.number}: "${issueData.title}" ===`);
    console.log(`Issue state: ${issueData.state}`);
    console.log(`Issue body length: ${issueData.body ? issueData.body.length : 0} chars`);
    console.log(`Comments count: ${issueData.comments.nodes.length}`);

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

    console.log(`Project fields for issue #${issueData.number}:`, Object.keys(fieldMap));
    console.log(`Status: "${fieldMap[STATUS_FIELD_NAME] || 'None'}"`);

    // Process body for images
    console.log(`Processing issue body for images...`);
    const processedBody = await processIssueBody(issueData.body);

    // Process comments for history tracking
    async function processCommentsForIssue(issueData, issueNumber) {
        console.log(`Processing ${issueData.comments.nodes.length} comments for issue #${issueNumber}`);

        const allComments = issueData.comments.nodes
            .filter(comment => !comment.body.includes("**Relationships**") &&
                !comment.body.includes("**Automated Notes**"))
            .map(async (comment) => {
                console.log(`Processing comment by ${comment.author?.login || "unknown"} on issue #${issueNumber}`);
                const processedBody = await processGitHubComment(comment.body);
                return {
                    body: processedBody,
                    originalBody: comment.body,
                    createdAt: comment.createdAt,
                    author: comment.author?.login || "unknown",
                    issueNumber: issueNumber
                };
            });

        // Wait for all comment processing to complete
        const processedComments = await Promise.all(allComments);

        console.log(`Processed ${processedComments.length} comments for issue #${issueNumber}`);

        // Create comment history entries
        const commentHistory = processedComments.map(comment => {
            const dateOnly = comment.createdAt.split('T')[0];
            const safeComment = comment.body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
            return `[${dateOnly}][${comment.author}] ${safeComment}`;
        });

        return commentHistory;
    }

    const commentHistory = await processCommentsForIssue(issueData, issueData.number);

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
        relationships: [],
        comments: [],
        commentHistory: commentHistory
    };

    // Remove null values and empty arrays that should be omitted
    Object.keys(frontmatter).forEach(key => {
        if (frontmatter[key] === null ||
            (Array.isArray(frontmatter[key]) && frontmatter[key].length === 0 && key !== 'comments')) {
            delete frontmatter[key];
        }
    });

    // Try to find existing file first
    let filePath = findExistingMarkdownFile(issueData.number);
    let isExistingFile = !!filePath;

    if (filePath) {
        console.log(`Found existing file: ${filePath}`);

        // Check if existing file needs updating
        const existingRaw = fs.readFileSync(filePath, "utf8");
        const existingParsed = matter(existingRaw);

        // Preserve existing commentHistory and relationships from local file
        if (existingParsed.data.commentHistory) {
            const existingHistory = Array.isArray(existingParsed.data.commentHistory) ?
                existingParsed.data.commentHistory : [];

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

            const newComments = commentHistory.filter(entry => {
                const match = entry.match(/\[.*?\]\[.*?\]\s*(.*)/);
                if (match) {
                    const content = match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
                    return !existingCommentContent.has(content);
                }
                return true;
            });

            frontmatter.commentHistory = [...existingHistory, ...newComments];
        }

        if (existingParsed.data.relationships) {
            frontmatter.relationships = existingParsed.data.relationships;
        }

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

        console.log(`Update needed: ${needsUpdate}`);
        if (needsUpdate) {
            console.log(`Changes detected:
- Title: ${existingParsed.data.title !== frontmatter.title}
- Description: ${existingParsed.data.description !== frontmatter.description}  
- Status: ${existingParsed.data.status !== frontmatter.status}
- Assignees: ${JSON.stringify(existingParsed.data.assignees) !== JSON.stringify(frontmatter.assignees)}
- Labels: ${JSON.stringify(existingParsed.data.labels) !== JSON.stringify(frontmatter.labels)}`);
        }

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
                    console.log(`Created status directory: ${newDir}`);
                }

                fs.renameSync(filePath, newPath);
                filePath = newPath;
                console.log(`Moved file to new status folder: ${path.relative(process.cwd(), filePath)}`);
            }
        }

    } else {
        // Create new file
        console.log(`Creating new markdown file for issue #${issueData.number} (no existing file found)`);

        frontmatter.comments = [];

        // Generate filename based on title
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
                console.log(`Created status directory: ${targetDir}`);
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

        console.log(`New file will be created at: ${filePath}`);
    }

    // Create markdown content
    const markdownContent = matter.stringify("", frontmatter);

    // Write file
    fs.writeFileSync(filePath, markdownContent);
    console.log(`${isExistingFile ? 'Updated' : 'Created'} markdown file: ${path.relative(process.cwd(), filePath)}`);

    return true;
}

// Main sync function
async function syncIssuesFromGitHub() {
    console.log("=== Starting GitHub issues sync ===");
    console.log(`Owner: ${OWNER}`);
    console.log(`Project Number: ${PROJECT_NUMBER}`);
    console.log(`Tasks Directory: ${TASKS_DIR}`);
    console.log(`Images Directory: ${IMAGES_DIR}`);
    console.log(`Status Field: ${STATUS_FIELD_NAME}`);

    ensureDirectories();

    try {
        // Get project and its issues
        console.log("\n=== Getting Project Information ===");
        const project = await getProjectNode();

        console.log("\n=== Getting Project Fields ===");
        const projectFields = await getProjectFields(project.id);
        console.log(`Available project fields: ${projectFields.map(f => f.name).join(', ')}`);

        console.log("\n=== Getting Project Issues ===");
        const projectIssues = await getProjectIssues(project.id);

        // Handle GitHub-side deletions FIRST (before processing issues)
        const deletionsMade = await handleGitHubSideDeletions(projectIssues);

        console.log(`\n=== Processing ${projectIssues.length} issues ===`);

        let updatedCount = 0;
        let skippedCount = 0;

        // Process each issue
        for (const issue of projectIssues) {
            if (!issue.content || issue.content.state === 'CLOSED') {
                console.log(`Skipping closed/invalid issue: ${issue.content ? `#${issue.content.number}` : 'Unknown'}`);
                skippedCount++;
                continue;
            }

            try {
                const wasUpdated = await createMarkdownFile(issue, projectFields);
                if (wasUpdated) updatedCount++;
            } catch (error) {
                console.error(`Failed to process issue #${issue.content.number}: ${error.message}`);
                console.error(`Stack: ${error.stack}`);
            }
        }

        console.log(`\n=== Sync Summary ===`);
        console.log(`Total issues found: ${projectIssues.length}`);
        console.log(`Files updated/created: ${updatedCount}`);
        console.log(`Issues skipped: ${skippedCount}`);
        console.log(`Deletions handled: ${deletionsMade ? 'Yes' : 'No'}`);
        console.log(`Sync completed successfully.`);

        return updatedCount + (deletionsMade ? 1 : 0);

    } catch (error) {
        console.error("=== Sync failed ===");
        console.error("Error:", error.message);
        console.error("Stack:", error.stack);
        throw error;
    }
}

// Run the sync
(async () => {
    try {
        await syncIssuesFromGitHub();
    } catch (error) {
        core.setFailed(`Sync failed: ${error.message}`);
        process.exit(1);
    }
})();