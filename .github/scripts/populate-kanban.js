// .github/scripts/populate-kanban.js
// Node 18+
// Requires: gray-matter, @actions/github, @actions/core

const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const core = require("@actions/core");
const github = require("@actions/github");

(async function main() {
    try {
        // --- ENV / CONFIG --------------------------------------------------------
        const token =
            process.env.PROJECTS_TOKEN ||
            process.env.GITHUB_TOKEN ||
            core.getInput("token") ||
            null;

        if (!token) {
            throw new Error("PROJECTS_TOKEN (or GITHUB_TOKEN) missing");
        }

        const PROJECT_OWNER = process.env.OWNER; // org or username that owns the Project v2
        const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER);
        const STATUS_FIELD_NAME = process.env.STATUS_FIELD_NAME || "Status";
        const TASKS_DIR = process.env.TASKS_DIR || "Tasks";

        const RELATIONSHIP_HEADER =
            process.env.RELATIONSHIP_HEADER || "Relationships";
        const COMMENT_HEADER = process.env.COMMENT_HEADER || "Automated Notes";

        if (!PROJECT_OWNER || !PROJECT_NUMBER) {
            throw new Error("OWNER/PROJECT_NUMBER missing");
        }

        // repo where issues will be created (the current workflow repo)
        const { owner: REPO_OWNER, repo: REPO_NAME } = github.context.repo;

        const octokit = github.getOctokit(token);

        // Normalize base dir to ABSOLUTE
        const tasksDirAbs = path.resolve(TASKS_DIR);

        // --- HELPERS -------------------------------------------------------------

        /** Recursively collect absolute paths of all .md under baseDir */
        function walkMdAbs(baseDir) {
            const out = [];
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(baseDir, e.name);
                if (e.isDirectory()) {
                    out.push(...walkMdAbs(full));
                } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
                    out.push(full);
                }
            }
            return out;
        }

        /** Safe mkdir -p */
        function ensureDir(dir) {
            fs.mkdirSync(dir, { recursive: true });
        }

        /** Read a markdown file (absolute path), return {data, content, orig} */
        function readMd(absPath) {
            const raw = fs.readFileSync(absPath, "utf8");
            const parsed = matter(raw);
            return { ...parsed, orig: raw };
        }

        /** Write back frontmatter + content to absolute file path */
        function writeMd(absPath, data, content) {
            const out = matter.stringify(content, data);
            fs.writeFileSync(absPath, out, "utf8");
        }

        /** Move a file from abs->abs if different */
        function moveIfNeeded(srcAbs, destAbs) {
            if (path.resolve(srcAbs) === path.resolve(destAbs)) return destAbs;
            ensureDir(path.dirname(destAbs));
            fs.renameSync(srcAbs, destAbs);
            return destAbs;
        }

        /** Returns repo id (node ID) and owner/repo info */
        async function getRepoNode() {
            const q = `
        query($owner:String!, $name:String!) {
          repository(owner:$owner, name:$name) { id name owner { login } }
        }
      `;
            const r = await octokit.graphql(q, { owner: REPO_OWNER, name: REPO_NAME });
            if (!r?.repository?.id) {
                throw new Error("Repository node not found");
            }
            return r.repository;
        }

        /** Get ProjectV2 node by OWNER and number */
        async function getProjectNode() {
            // Try as org first, then as user
            const q = `
        query($org:String!, $user:String!, $num:Int!) {
          org: organization(login:$org) { projectV2(number:$num) { id title } }
          usr: user(login:$user) { projectV2(number:$num) { id title } }
        }
      `;
            const r = await octokit.graphql(q, {
                org: PROJECT_OWNER,
                user: PROJECT_OWNER,
                num: PROJECT_NUMBER,
            });

            const proj = r?.org?.projectV2 || r?.usr?.projectV2;
            if (!proj?.id) {
                throw new Error(
                    `Project v2 #${PROJECT_NUMBER} not found for ${PROJECT_OWNER}`
                );
            }
            return proj;
        }

        /** Get all fields for project; return { fieldByName, statusOptionsByName } */
        async function getProjectFields(projectId) {
            const q = `
        query($id:ID!) {
          node(id:$id) {
            ... on ProjectV2 {
              fields(first:100) {
                nodes {
                  ... on ProjectV2FieldCommon { id name dataType }
                  ... on ProjectV2SingleSelectField { id name dataType options { id name } }
                }
              }
            }
          }
        }
      `;
            const r = await octokit.graphql(q, { id: projectId });
            const nodes = r?.node?.fields?.nodes || [];

            const fieldByName = new Map();
            for (const f of nodes) fieldByName.set(f.name, f);

            let statusField = fieldByName.get(STATUS_FIELD_NAME);
            if (!statusField) {
                throw new Error(
                    `Project field "${STATUS_FIELD_NAME}" not found. Create a single-select field named "${STATUS_FIELD_NAME}".`
                );
            }
            const options = (statusField.options || []).map((o) => ({
                id: o.id,
                name: o.name,
            }));
            const statusOptionsByName = new Map(
                options.map((o) => [o.name.toLowerCase(), o])
            );

            return { fieldByName, statusField, statusOptionsByName };
        }

        /** Ensure issue exists; if not, create; return {number, id} */
        async function ensureIssue({ title, body, existingNumber }) {
            if (existingNumber) {
                // Get node id for existing issue
                const { data } = await octokit.rest.issues.get({
                    owner: REPO_OWNER,
                    repo: REPO_NAME,
                    issue_number: Number(existingNumber),
                });
                return { number: data.number, id: data.node_id, html_url: data.html_url };
            }
            const { data } = await octokit.rest.issues.create({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                title,
                body,
            });
            return { number: data.number, id: data.node_id, html_url: data.html_url };
        }

        /** Add issue (contentId) to Project v2; returns itemId (project item) */
        async function addToProject({ projectId, contentId }) {
            const m = `
        mutation($projectId:ID!, $contentId:ID!) {
          addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}) {
            item { id }
          }
        }
      `;
            const r = await octokit.graphql(m, { projectId, contentId });
            return r?.addProjectV2ItemById?.item?.id;
        }

        /** Set single-select status on item */
        async function setStatus({ projectId, itemId, statusField, statusOptionsByName, statusName }) {
            const target = statusOptionsByName.get((statusName || "").toLowerCase());
            if (!target) {
                core.warning(
                    `Status "${statusName}" not found in project options; skipping status set`
                );
                return;
            }
            const m = `
        mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
          updateProjectV2ItemFieldValue(input:{
            projectId:$projectId,
            itemId:$itemId,
            fieldId:$fieldId,
            value:{ singleSelectOptionId:$optionId }
          }) { projectV2Item { id } }
        }
      `;
            await octokit.graphql(m, {
                projectId,
                itemId,
                fieldId: statusField.id,
                optionId: target.id,
            });
        }

        /** Optional: post a comment to the GitHub Issue */
        async function postIssueComment(issueNumber, body) {
            if (!body || !String(body).trim()) return;
            await octokit.rest.issues.createComment({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                issue_number: Number(issueNumber),
                body,
            });
        }

        /** Extract a section by header from markdown content (ATX style) */
        function extractSection(content, headerText) {
            // Match '## Header', '### Header', etc., until next header or end
            const esc = headerText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(
                `^#{1,6}\\s*${esc}\\s*\\n([\\s\\S]*?)(?=^#{1,6}\\s|\\Z)`,
                "im"
            );
            const m = content.match(re);
            return m ? m[1].trim() : "";
        }

        // --- PREP: Project + fields ---------------------------------------------
        const repoNode = await getRepoNode();
        const projectNode = await getProjectNode();
        const { statusField, statusOptionsByName } = await getProjectFields(
            projectNode.id
        );

        // --- PROCESS FILES -------------------------------------------------------
        if (!fs.existsSync(tasksDirAbs)) {
            core.info(`Tasks directory "${tasksDirAbs}" does not exist. Nothing to do.`);
            return;
        }

        const mdFilesAbs = walkMdAbs(tasksDirAbs);
        if (!mdFilesAbs.length) {
            core.info(`No markdown files found under ${tasksDirAbs}`);
            return;
        }

        core.info(`Found ${mdFilesAbs.length} markdown file(s)`);

        for (const fileAbs of mdFilesAbs) {
            core.startGroup(`Processing: ${path.relative(process.cwd(), fileAbs)}`);
            try {
                const { data, content } = readMd(fileAbs);

                // Title: frontmatter title | filename (without extension)
                const title =
                    data.title ||
                    data.Name ||
                    path.basename(fileAbs).replace(/\.md$/i, "");

                // Optional body from content (excluding frontmatter)
                const body = content && content.trim() ? content : undefined;

                // Status from frontmatter
                const status =
                    (data.Status || data.status || "Backlog").toString().trim();

                // If you have a section to post as comment:
                const notes = extractSection(content || "", COMMENT_HEADER);

                // Existing issue number?
                const existingIssueNum =
                    data.issue ||
                    data.issue_number ||
                    data.Issue ||
                    data.IssueNumber ||
                    null;

                // Ensure Issue exists (create if needed)
                const issue = await ensureIssue({
                    title,
                    body,
                    existingNumber: existingIssueNum,
                });

                // Write back the issue number if it was missing
                if (!existingIssueNum) {
                    data.issue = issue.number; // normalize to 'issue'
                    writeMd(fileAbs, data, content || "");
                    core.info(`Wrote issue number ${issue.number} back to frontmatter`);
                }

                // Add to Project v2 (safe if already present)
                const itemId = await addToProject({
                    projectId: projectNode.id,
                    contentId: issue.id,
                });
                if (itemId) {
                    core.info(`Added to project ${PROJECT_NUMBER} (item ${itemId})`);
                    await setStatus({
                        projectId: projectNode.id,
                        itemId,
                        statusField,
                        statusOptionsByName,
                        statusName: status,
                    });
                } else {
                    core.warning("Could not add to project (item id empty)");
                }

                // Post notes as issue comment (optional)
                if (notes) {
                    await postIssueComment(issue.number, notes);
                    core.info(`Posted "${COMMENT_HEADER}" as issue comment`);
                }

                // Move file into Tasks/<Status>/filename.md
                //  - Keep filename
                //  - Preserve subfolder structure *beneath* status? (simple version: flatten by filename)
                //  - If you want to preserve relative subpath, compute from base
                const relativeFromBase = path.relative(tasksDirAbs, fileAbs);
                const fileName = path.basename(relativeFromBase);
                const safeStatus = status.replace(/[\\/]+/g, "-").trim() || "Backlog";
                const destDirAbs = path.join(tasksDirAbs, safeStatus);
                const destAbs = path.join(destDirAbs, fileName);

                const afterMoveAbs = moveIfNeeded(fileAbs, destAbs);
                core.info(`Located at: ${path.relative(process.cwd(), afterMoveAbs)}`);
            } catch (err) {
                core.warning(`Failed to process ${fileAbs}: ${err.message}`);
            } finally {
                core.endGroup();
            }
        }

        // --- COMMIT CHANGES (frontmatter writes / moves) -------------------------
        if (fs.existsSync(".git")) {
            const { execSync } = require("child_process");
            try {
                const status = execSync("git status --porcelain").toString().trim();
                if (status) {
                    execSync('git config user.name "github-actions[bot]"');
                    execSync(
                        'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"'
                    );
                    execSync("git add -A");
                    execSync('git commit -m "chore(kanban): sync issues & move files"');
                    execSync("git push");
                    core.info("Changes committed and pushed.");
                } else {
                    core.info("No changes to commit.");
                }
            } catch (e) {
                core.warning(`Commit skipped: ${e.message}`);
            }
        }
    } catch (err) {
        core.setFailed(err.message);
        process.exit(1);
    }
})();
