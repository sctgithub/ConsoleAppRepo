const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const core = require("@actions/core");
const github = require("@actions/github");
const https = require("https");

const token = process.env.PROJECTS_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = process.env.OWNER;
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER);
const STATUS_FIELD_NAME = process.env.STATUS_FIELD_NAME || "Status";
const TASKS_DIR = process.env.TASKS_DIR || "Tasks";
const SYNC_MODE = process.env.SYNC_MODE || "missing"; // "missing", "all", or "force"

if (!token) { core.setFailed("PROJECTS_TOKEN missing"); process.exit(1); }
if (!OWNER || !PROJECT_NUMBER) { core.setFailed("OWNER/PROJECT_NUMBER missing"); process.exit(1); }

const octokit = github.getOctokit(token);

// Get all issues from the project
async function getProjectIssuesWithDetails(projectId) {
    const query = `
    query($projectId: ID!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              fieldValues(first: 20) {
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
                  number
                  title
                  body
                  assignees(first: 10) {
                    nodes {
                      login
                    }
                  }
                  labels(first: 10) {
                    nodes {
                      name
                    }
                  }
                  milestone {
                    title
                  }
                  comments(first: 100) {
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
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
        const response = await octokit.graphql(query, {
            projectId,
            after: cursor
        });

        const items = response.node.items.nodes.filter(item => item.content && item.content.number);

        for (const item of items) {
            const issue = item.content;
            const fields = {};

            // Extract project field values
            for (const fieldValue of item.fieldValues.nodes) {
                if (fieldValue.field && fieldValue.field.name) {
                    const fieldName = fieldValue.field.name;
                    if (fieldValue.text !== undefined) fields[fieldName] = fieldValue.text;
                    else if (fieldValue.number !== undefined) fields[fieldName] = fieldValue.number;
                    else if (fieldValue.date !== undefined) fields[fieldName] = fieldValue.date;
                    else if (fieldValue.name !== undefined) fields[fieldName] = fieldValue.name;
                }
            }

            allIssues.push({
                number: issue.number,
                title: issue.title,
                body: issue.body || "",
                assignees: issue.assignees.nodes.map(a => a.login),
                labels: issue.labels.nodes.map(l => l.name),
                milestone: issue.milestone?.title,
                comments: issue.comments.nodes,
                fields: fields
            });
        }

        hasNextPage = response.node.items.pageInfo.hasNextPage;
        cursor = response.node.items.pageInfo.endCursor;
    }

    return allIssues;
}

// Download image from URL
async function downloadImage(url, filePath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download image: ${response.statusCode}`));
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
            file.on('error', reject);
        }).on('error', reject);
    });
}

// Extract and download images from comments
async function processIssueImages(issueNumber, comments, baseDir) {
    const imageRegex = /!\[([^\]]*)\]\((https:\/\/[^)]+)\)/g;
    const processedComments = [];

    // Ensure Images directory exists
    const imagesDir = path.join(baseDir, "Images");
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }

    for (let i = 0; i < comments.length; i++) {
        let commentText = comments[i].body;
        let match;
        let imageCounter = 1;

        // Process each image in the comment
        while ((match = imageRegex.exec(commentText)) !== null) {
            const [fullMatch, altText, imageUrl] = match;

            try {
                // Generate local filename
                const urlParts = imageUrl.split('/');
                const originalName = urlParts[urlParts.length - 1];
                const extension = path.extname(originalName) || '.png';
                const localFileName = `issue${issueNumber}_comment${i + 1}_img${imageCounter}${extension}`;
                const localPath = path.join(imagesDir, localFileName);

                // Download the image
                await downloadImage(imageUrl, localPath);
                console.log(`Downloaded image: ${localFileName}`);

                // Replace URL with local path
                const relativePath = `../Images/${localFileName}`;
                commentText = commentText.replace(fullMatch, `![${altText}](${relativePath})`);

                imageCounter++;
            } catch (error) {
                console.warn(`Failed to download image from ${imageUrl}:`, error.message);
                // Keep original URL if download fails
            }
        }

        // Reset regex for next iteration
        imageRegex.lastIndex = 0;

        processedComments.push({
            ...comments[i],
            body: commentText
        });
    }

    return processedComments;
}

// Generate markdown from issue data
async function createMarkdownFromIssue(issue, template = "basic") {
    const { owner, repo } = github.context.repo;

    // Determine status folder
    const status = issue.fields[STATUS_FIELD_NAME] || "Backlog";
    const safeStatus = String(status).trim().replace(/[/\\<>:"|?*]+/g, "_");
    const statusDir = path.join(TASKS_DIR, safeStatus);

    // Create status directory if it doesn't exist
    if (!fs.existsSync(statusDir)) {
        fs.mkdirSync(statusDir, { recursive: true });
    }

    // Process images in comments
    const processedComments = await processIssueImages(issue.number, issue.comments, statusDir);

    // Filter out automated comments
    const userComments = processedComments.filter(comment => {
        const body = comment.body || "";
        return !body.includes("**Relationships**") &&
            !body.includes("**Automated Notes**") &&
            comment.author?.login !== "github-actions[bot]";
    }).map(comment => comment.body);

    // Create frontmatter based on template
    const frontmatter = {
        title: issue.title,
        description: issue.body || `Issue #${issue.number}`,
        issue: issue.number,
        status: status,
        assignees: issue.assignees,
        labels: issue.labels,
        priority: issue.fields.Priority || "Medium",
        sprint: issue.fields.Sprint || "Sprint 1",
    };

    // Add fields based on template
    if (template === "advanced") {
        frontmatter.size = issue.fields.Size || "M";
        frontmatter.estimate = issue.fields.Estimate || 5;
        frontmatter.devHours = issue.fields["Dev Hours"] || 3;
        frontmatter.qaHours = issue.fields["QA Hours"] || 1;
        frontmatter.plannedStart = issue.fields["Planned Start"] || "2025-09-01";
        frontmatter.plannedEnd = issue.fields["Planned End"] || "2025-09-10";
        frontmatter.actualStart = issue.fields["Actual Start"] || "";
        frontmatter.actualEnd = issue.fields["Actual End"] || "";
        frontmatter.relationships = [];
        frontmatter.subIssues = []; // Would need additional logic to detect sub-issues
    } else {
        frontmatter.size = issue.fields.Size || "S";
        frontmatter.estimate = issue.fields.Estimate || 3;
        frontmatter.devHours = issue.fields["Dev Hours"] || 2;
        frontmatter.qaHours = issue.fields["QA Hours"] || 1;
        frontmatter.plannedStart = issue.fields["Planned Start"] || "2025-09-01";
        frontmatter.plannedEnd = issue.fields["Planned End"] || "2025-09-10";
        frontmatter.actualStart = issue.fields["Actual Start"] || "";
        frontmatter.actualEnd = issue.fields["Actual End"] || "";
        frontmatter.relationships = [];
    }

    if (issue.milestone) {
        frontmatter.milestone = issue.milestone;
    }

    frontmatter.comments = userComments;
    frontmatter.commentHistory = [];

    // Generate filename
    const filename = `${issue.number}-${issue.title.replace(/[/\\<>:"|?*]+/g, "_").substring(0, 50)}.md`;
    const filePath = path.join(statusDir, filename);

    // Create markdown content
    const markdownContent = matter.stringify("", frontmatter);

    return { filePath, content: markdownContent };
}

// Check if markdown file already exists for an issue
function findExistingMarkdownFile(issueNumber) {
    const walkDir = (dir) => {
        if (!fs.existsSync(dir)) return null;

        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                const result = walkDir(fullPath);
                if (result) return result;
            } else if (file.name.endsWith('.md')) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const parsed = matter(content);
                    if (parsed.data.issue === issueNumber) {
                        return fullPath;
                    }
                } catch (error) {
                    // Skip files that can't be parsed
                }
            }
        }
        return null;
    };

    return walkDir(TASKS_DIR);
}

// Get all existing markdown files with their issue numbers
function getAllExistingMarkdownFiles() {
    const files = [];

    const walkDir = (dir) => {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkDir(fullPath);
            } else if (entry.name.endsWith('.md')) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const parsed = matter(content);
                    if (parsed.data.issue) {
                        files.push({
                            filePath: fullPath,
                            issueNumber: parsed.data.issue,
                            fileName: entry.name,
                            directory: path.dirname(fullPath)
                        });
                    }
                } catch (error) {
                    console.warn(`Could not parse ${fullPath}:`, error.message);
                }
            }
        }
    };

    walkDir(TASKS_DIR);
    return files;
}

// Clean up orphaned images in a directory
function cleanupOrphanedImages(directory) {
    const imagesDir = path.join(directory, 'Images');
    if (!fs.existsSync(imagesDir)) return;

    try {
        const imageFiles = fs.readdirSync(imagesDir);
        let deletedImages = 0;

        for (const imageFile of imageFiles) {
            const imagePath = path.join(imagesDir, imageFile);
            try {
                fs.unlinkSync(imagePath);
                deletedImages++;
                console.log(`Deleted orphaned image: ${path.relative(process.cwd(), imagePath)}`);
            } catch (error) {
                console.warn(`Failed to delete image ${imagePath}:`, error.message);
            }
        }

        // Remove empty Images directory
        try {
            fs.rmdirSync(imagesDir);
            console.log(`Removed empty Images directory: ${path.relative(process.cwd(), imagesDir)}`);
        } catch (error) {
            // Directory might not be empty or might not exist
        }

        return deletedImages;
    } catch (error) {
        console.warn(`Error cleaning up images in ${imagesDir}:`, error.message);
        return 0;
    }
}

// Delete orphaned markdown files and their attachments
function deleteOrphanedMarkdownFiles(existingFiles, currentIssueNumbers) {
    let deletedFiles = 0;
    let deletedImages = 0;
    const processedDirectories = new Set();

    for (const fileInfo of existingFiles) {
        if (!currentIssueNumbers.has(fileInfo.issueNumber)) {
            try {
                // Delete the markdown file
                fs.unlinkSync(fileInfo.filePath);
                deletedFiles++;
                console.log(`Deleted orphaned markdown file: ${path.relative(process.cwd(), fileInfo.filePath)}`);

                // Track directory for later cleanup
                processedDirectories.add(fileInfo.directory);

            } catch (error) {
                console.warn(`Failed to delete ${fileInfo.filePath}:`, error.message);
            }
        }
    }

    // Clean up Images directories from processed directories
    for (const directory of processedDirectories) {
        deletedImages += cleanupOrphanedImages(directory);

        // Try to remove empty status directories
        try {
            const entries = fs.readdirSync(directory);
            if (entries.length === 0) {
                fs.rmdirSync(directory);
                console.log(`Removed empty directory: ${path.relative(process.cwd(), directory)}`);
            }
        } catch (error) {
            // Directory might not be empty or might not exist
        }
    }

    return { deletedFiles, deletedImages };
}

// Get project info
async function getProjectNode() {
    const orgQ = `query($login:String!,$number:Int!){ organization(login:$login){ projectV2(number:$number){ id title }}}`;
    const userQ = `query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id title }}}`;
    const asOrg = await octokit.graphql(orgQ, { login: OWNER, number: PROJECT_NUMBER }).catch(() => null);
    if (asOrg?.organization?.projectV2) return asOrg.organization.projectV2;
    const asUser = await octokit.graphql(userQ, { login: OWNER, number: PROJECT_NUMBER }).catch(() => null);
    if (asUser?.user?.projectV2) return asUser.user.projectV2;
    throw new Error(`Project v2 #${PROJECT_NUMBER} not found for ${OWNER}`);
}

// Main execution
(async () => {
    console.log(`Syncing GitHub issues to markdown files (mode: ${SYNC_MODE})...`);

    const project = await getProjectNode();
    const issues = await getProjectIssuesWithDetails(project.id);

    console.log(`Found ${issues.length} issues in project`);

    // Get current issue numbers from the project
    const currentIssueNumbers = new Set(issues.map(issue => issue.number));

    // Get all existing markdown files
    const existingFiles = getAllExistingMarkdownFiles();
    console.log(`Found ${existingFiles.length} existing markdown files`);

    // Clean up orphaned files (only if not in missing mode)
    let deletedFiles = 0;
    let deletedImages = 0;

    if (SYNC_MODE !== "missing") {
        console.log("Checking for orphaned markdown files to clean up...");
        const cleanup = deleteOrphanedMarkdownFiles(existingFiles, currentIssueNumbers);
        deletedFiles = cleanup.deletedFiles;
        deletedImages = cleanup.deletedImages;

        if (deletedFiles > 0) {
            console.log(`Cleaned up ${deletedFiles} orphaned markdown files and ${deletedImages} images`);
        } else {
            console.log("No orphaned files found to clean up");
        }
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const issue of issues) {
        const existingFile = findExistingMarkdownFile(issue.number);

        if (existingFile && SYNC_MODE === "missing") {
            console.log(`Skipping issue #${issue.number} - markdown file already exists`);
            skipped++;
            continue;
        }

        try {
            // Determine template based on complexity
            const template = issue.fields.Size === "L" ||
                issue.assignees.length > 1 ||
                issue.labels.length > 2 ? "advanced" : "basic";

            const { filePath, content } = await createMarkdownFromIssue(issue, template);

            if (existingFile && SYNC_MODE === "all") {
                // Update existing file
                fs.writeFileSync(existingFile, content);
                console.log(`Updated: ${path.relative(process.cwd(), existingFile)} for issue #${issue.number}`);
                updated++;
            } else if (SYNC_MODE === "force" || !existingFile) {
                // Create new file
                fs.writeFileSync(filePath, content);
                console.log(`Created: ${path.relative(process.cwd(), filePath)} for issue #${issue.number}`);
                created++;
            }

        } catch (error) {
            console.error(`Failed to process issue #${issue.number}:`, error.message);
        }
    }

    console.log(`\nSync complete:`);
    console.log(`  Created: ${created} files`);
    console.log(`  Updated: ${updated} files`);
    console.log(`  Deleted: ${deletedFiles} files`);
    console.log(`  Skipped: ${skipped} files`);
    console.log(`  Cleaned images: ${deletedImages} files`);

    // Commit changes if any files were created/updated/deleted
    if (created > 0 || updated > 0 || deletedFiles > 0) {
        const { execSync } = require("child_process");
        try {
            // Pull latest changes first to avoid conflicts
            try {
                execSync("git pull --rebase origin main", { stdio: 'pipe' });
                console.log("Successfully pulled latest changes");
            } catch (pullError) {
                console.warn("Pull failed, proceeding with local changes:", pullError.message);
            }

            execSync('git config user.name "github-actions[bot]"');
            execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
            execSync("git add -A");
            execSync(`git commit -m "Sync: ${created} new, ${updated} updated, ${deletedFiles} deleted markdown files from GitHub issues"`);

            // Try to push, with retry logic
            let pushAttempts = 0;
            const maxPushAttempts = 3;

            while (pushAttempts < maxPushAttempts) {
                try {
                    execSync("git push origin main", { stdio: 'pipe' });
                    console.log("Changes committed and pushed to repository");
                    break;
                } catch (pushError) {
                    pushAttempts++;
                    console.warn(`Push attempt ${pushAttempts} failed:`, pushError.message);

                    if (pushAttempts < maxPushAttempts) {
                        // Pull again and retry
                        try {
                            execSync("git pull --rebase origin main", { stdio: 'pipe' });
                            console.log("Pulled changes before retry");
                        } catch (retryPullError) {
                            console.warn("Retry pull failed:", retryPullError.message);
                        }
                    } else {
                        console.error("Failed to push after maximum attempts");
                    }
                }
            }
        } catch (error) {
            console.warn("Failed to commit changes:", error.message);
        }
    }

})().catch(err => core.setFailed(err.message));