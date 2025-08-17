const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const core = require("@actions/core");
const github = require("@actions/github");
const { glob } = require("glob");

// Use PROJECTS_TOKEN (PAT) or fall back to GITHUB_TOKEN
const token = process.env.PROJECTS_TOKEN || process.env.GITHUB_TOKEN;

const OWNER = process.env.OWNER;
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER);
const STATUS_FIELD_NAME = process.env.STATUS_FIELD_NAME || "Status";
const TASKS_DIR = process.env.TASKS_DIR || "Tasks";

if (!token) throw new Error("PROJECTS_TOKEN (or GITHUB_TOKEN) is required");
if (!OWNER) throw new Error("OWNER is required");
if (!PROJECT_NUMBER) throw new Error("PROJECT_NUMBER is required");

const octokit = github.getOctokit(token);

// Status mapping for your kanban columns
const STATUS_MAPPING = {
  'backlog': 'Backlog',
  'ready': 'Ready',
  'in progress': 'In progress',
  'in review': 'In review',
  'ready for deploy to test': 'Ready for deploy to test',
  'in testing': 'In testing',
  'ready for deploy to staging': 'Ready for deploy to staging',
  'done': 'Done',
  'archive': 'Archive'
};

// ---------- Helper Functions ----------

async function findExistingIssue({ owner, repo, title, issueNumber }) {
  try {
    // If issue number is provided, try to find by number first
    if (issueNumber) {
      try {
        const issue = await octokit.rest.issues.get({
          owner,
          repo,
          issue_number: issueNumber
        });
        return {
          number: issue.data.number,
          node_id: issue.data.node_id,
          html_url: issue.data.html_url,
          found: true
        };
      } catch (error) {
        console.log(`Issue #${issueNumber} not found, searching by title...`);
      }
    }

    // Search by title
    const q = `repo:${owner}/${repo} is:issue "${title.replace(/"/g, '\\"')}" in:title`;
    const search = await octokit.rest.search.issuesAndPullRequests({ q });
    const existing = search.data.items.find(i => i.title === title && !i.pull_request);

    if (existing) {
      return {
        number: existing.number,
        node_id: existing.node_id,
        html_url: existing.html_url,
        found: true
      };
    }

    return { found: false };
  } catch (error) {
    console.error('Error searching for existing issue:', error);
    return { found: false };
  }
}

async function createOrUpdateIssue({ owner, repo, title, body, labels, existingIssue }) {
  try {
    if (existingIssue.found) {
      console.log(`Updating existing issue #${existingIssue.number}: ${title}`);
      
      const updated = await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: existingIssue.number,
        title,
        body,
        labels: labels || []
      });

      return {
        number: updated.data.number,
        node_id: updated.data.node_id,
        html_url: updated.data.html_url,
        created: false
      };
    } else {
      console.log(`Creating new issue: ${title}`);
      
      const created = await octokit.rest.issues.create({
        owner,
        repo,
        title,
        body,
        labels: labels || []
      });

      return {
        number: created.data.number,
        node_id: created.data.node_id,
        html_url: created.data.html_url,
        created: true
      };
    }
  } catch (error) {
    console.error('Error creating/updating issue:', error);
    throw error;
  }
}

async function getProjectNode() {
  try {
    // Try organization project first
    const orgQuery = `
      query($login: String!, $number: Int!) {
        organization(login: $login) {
          projectV2(number: $number) {
            id
            title
          }
        }
      }
    `;
    
    const orgRes = await octokit.graphql(orgQuery, { 
      login: OWNER, 
      number: PROJECT_NUMBER 
    }).catch(() => null);
    
    if (orgRes?.organization?.projectV2) {
      console.log(`Found organization project: ${orgRes.organization.projectV2.title}`);
      return orgRes.organization.projectV2;
    }

    // Try user project
    const userQuery = `
      query($login: String!, $number: Int!) {
        user(login: $login) {
          projectV2(number: $number) {
            id
            title
          }
        }
      }
    `;
    
    const userRes = await octokit.graphql(userQuery, { 
      login: OWNER, 
      number: PROJECT_NUMBER 
    }).catch(() => null);
    
    if (userRes?.user?.projectV2) {
      console.log(`Found user project: ${userRes.user.projectV2.title}`);
      return userRes.user.projectV2;
    }

    throw new Error(`Project v2 #${PROJECT_NUMBER} not found for owner ${OWNER}`);
  } catch (error) {
    console.error('Error finding project:', error);
    throw error;
  }
}

async function getStatusField(projectId) {
  try {
    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 50) {
              nodes {
                ... on ProjectV2FieldCommon {
                  id
                  name
                  dataType
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  dataType
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const res = await octokit.graphql(query, { projectId });
    const fields = res.node.fields.nodes;
    const statusField = fields.find(f => 
      f.name === STATUS_FIELD_NAME && f.dataType === "SINGLE_SELECT"
    );

    if (!statusField) {
      const available = fields.map(f => `${f.name} [${f.dataType}]`).join(", ");
      throw new Error(`Single-select field "${STATUS_FIELD_NAME}" not found. Available: ${available}`);
    }

    console.log(`Found status field with options: ${statusField.options.map(o => o.name).join(', ')}`);
    return statusField;
  } catch (error) {
    console.error('Error getting status field:', error);
    throw error;
  }
}

async function addIssueToProject({ projectId, issueNodeId }) {
  try {
    const mutation = `
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { 
          projectId: $projectId, 
          contentId: $contentId 
        }) {
          item {
            id
          }
        }
      }
    `;
    
    const res = await octokit.graphql(mutation, { 
      projectId, 
      contentId: issueNodeId 
    });
    
    return res.addProjectV2ItemById.item.id;
  } catch (error) {
    // If item already exists in project, that's ok
    if (error.message.includes('already exists')) {
      console.log('Issue already exists in project');
      return await getExistingProjectItemId(projectId, issueNodeId);
    }
    console.error('Error adding issue to project:', error);
    throw error;
  }
}

async function getExistingProjectItemId(projectId, issueNodeId) {
  try {
    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100) {
              nodes {
                id
                content {
                  ... on Issue {
                    id
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const res = await octokit.graphql(query, { projectId });
    const item = res.node.items.nodes.find(
      item => item.content?.id === issueNodeId
    );
    
    return item?.id;
  } catch (error) {
    console.error('Error getting existing project item ID:', error);
    return null;
  }
}

async function updateProjectItemStatus({ projectId, itemId, fieldId, optionId }) {
  try {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `;
    
    await octokit.graphql(mutation, { 
      projectId, 
      itemId, 
      fieldId, 
      optionId 
    });
  } catch (error) {
    console.error('Error updating project item status:', error);
    throw error;
  }
}

function buildIssueBody(data, content, filePath) {
  let body = '';
  
  // Add description
  if (data.description) {
    body += `## Description\n${data.description}\n\n`;
  }
  
  // Add task details table
  body += '## Task Details\n';
  body += '| Field | Value |\n';
  body += '|-------|-------|\n';
  
  const fields = [
    { key: 'status', label: 'Status' },
    { key: 'size', label: 'Size' },
    { key: 'estimate', label: 'Estimate' },
    { key: 'devHours', label: 'Dev Hours' },
    { key: 'qaHours', label: 'QA Hours' },
    { key: 'plannedStart', label: 'Planned Start' },
    { key: 'plannedEnd', label: 'Planned End' },
    { key: 'actualStart', label: 'Actual Start' },
    { key: 'actualEnd', label: 'Actual End' },
    { key: 'priority', label: 'Priority' },
    { key: 'sprint', label: 'Sprint' }
  ];
  
  fields.forEach(field => {
    if (data[field.key]) {
      body += `| ${field.label} | ${data[field.key]} |\n`;
    }
  });
  
  if (data.assignees && data.assignees.length > 0) {
    body += `| Assignees | ${data.assignees.join(', ')} |\n`;
  }
  
  if (data.relationships) {
    body += `| Relationships | ${data.relationships} |\n`;
  }
  
  // Add comments if present
  if (data.comments) {
    body += `\n## Comments\n${data.comments}\n`;
  }
  
  // Add additional content
  if (content.trim()) {
    body += `\n## Additional Details\n${content}\n`;
  }
  
  // Add source file reference
  body += `\n---\n*Source: \`${filePath}\`*`;
  
  return body;
}

function getRepoContext() {
  const { owner, repo } = github.context.repo;
  return { owner, repo };
}

// ---------- Main Function ----------

(async () => {
  try {
    const tasksDir = path.join(process.cwd(), TASKS_DIR);
    
    if (!fs.existsSync(tasksDir)) {
      console.log(`No ${TASKS_DIR}/ directory — nothing to do.`);
      return;
    }

    // Find all .md files recursively in Tasks directory
    const pattern = path.join(tasksDir, '**/*.md').replace(/\\/g, '/');
    const files = await glob(pattern);
    
    if (!files.length) {
      console.log(`No .md files found in ${TASKS_DIR}/ — nothing to do.`);
      return;
    }

    console.log(`Found ${files.length} task files`);

    const { owner, repo } = getRepoContext();
    console.log(`Using repository: ${owner}/${repo}`);

    // Get project and status field info
    const project = await getProjectNode();
    const statusField = await getStatusField(project.id);
    
    // Create mapping of status names to option IDs
    const optionsByName = new Map();
    statusField.options.forEach(option => {
      optionsByName.set(option.name.toLowerCase(), option);
    });

    // Process each markdown file
    for (const filePath of files) {
      try {
        console.log(`\nProcessing: ${filePath}`);
        
        const raw = fs.readFileSync(filePath, "utf8");
        const { data, content } = matter(raw);

        // Get task data
        const title = (data.title || path.basename(filePath, ".md")).trim();
        const body = buildIssueBody(data, content, filePath);
        const labels = data.labels || [];
        const issueNumber = data.issue;
        const statusName = data.status;

        if (!title) {
          console.log(`Skipping ${filePath} — missing title`);
          continue;
        }

        // Find or create issue
        const existingIssue = await findExistingIssue({ 
          owner, 
          repo, 
          title, 
          issueNumber 
        });
        
        const issue = await createOrUpdateIssue({ 
          owner, 
          repo, 
          title, 
          body, 
          labels, 
          existingIssue 
        });

        console.log(`${issue.created ? "Created" : "Updated"} issue #${issue.number}: ${issue.html_url}`);

        // Add issue to project (or get existing item ID)
        let itemId = await addIssueToProject({ 
          projectId: project.id, 
          issueNodeId: issue.node_id 
        });

        if (!itemId) {
          itemId = await getExistingProjectItemId(project.id, issue.node_id);
        }

        if (itemId) {
          console.log(`Issue #${issue.number} added to project with item ID: ${itemId}`);

          // Update status if provided
          if (statusName) {
            const normalizedStatus = statusName.toLowerCase();
            const mappedStatus = STATUS_MAPPING[normalizedStatus] || statusName;
            const option = optionsByName.get(mappedStatus.toLowerCase());

            if (option) {
              await updateProjectItemStatus({
                projectId: project.id,
                itemId,
                fieldId: statusField.id,
                optionId: option.id
              });
              console.log(`Set status to "${option.name}" for issue #${issue.number}`);
            } else {
              const available = [...optionsByName.keys()].join(", ");
              console.warn(`Status "${statusName}" not found. Available: ${available}`);
            }
          } else {
            console.log(`No status specified in ${filePath} — leaving default`);
          }
        } else {
          console.error(`Failed to get project item ID for issue #${issue.number}`);
        }

      } catch (error) {
        console.error(`Error processing ${filePath}:`, error);
        continue; // Continue with next file
      }
    }

    console.log('\n✅ Sync completed successfully!');

  } catch (error) {
    console.error('❌ Sync failed:', error);
    core.setFailed(error.message);
  }
})();