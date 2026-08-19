#!/usr/bin/env node
/**
 * sync-stories-to-github.mjs — make GitHub reflect the local story files.
 *
 * `stories/*.md` is where a story's state actually changes — the wiz stories
 * CLI rewrites the front matter and the filename as work moves — and GitHub
 * learns none of it. The issues under the tracking epic and their project cards
 * drift out of date within the hour, so keeping them honest by hand is not
 * viable.
 *
 * This script closes the gap in one direction only: stories are read, GitHub is
 * written. It never edits a story file.
 *
 * It is declarative, not incremental. Every run fetches live GitHub state,
 * computes what each story should look like there, and writes only the
 * differences. A no-op run prints "In sync", so it is safe to re-run, and an
 * issue somebody edited by hand gets pulled back into line rather than
 * double-applied.
 *
 * What it syncs, and from where:
 *
 *   the issue itself   <- story        (a story with no issue gets one created)
 *   issue open/closed  <- story status (complete/wontfix close the issue)
 *   Start date         <- story status (in_progress and complete get today)
 *   project Status     <- story status (see STORY_RULES)
 *   project Size       <- issue Effort (see SIZE_FOR_EFFORT)
 *
 * Effort is the one field this script will not decide. It is a human judgement,
 * so a newly created issue gets EFFORT_DEFAULT and is reported as having been
 * defaulted; change it in the GitHub UI and Size follows on the next run.
 *
 * An issue is matched to its story by the `Tracked locally as story `NNN-hhhh``
 * marker that creation puts in the issue body. That marker is load-bearing: an
 * issue that loses it looks like a story with no issue, and a second issue gets
 * created. Do not edit it out.
 *
 * Field and option ids are resolved by name at runtime. Hardcoding the opaque
 * `PVTSSF_…`/`IFD_…` ids works right up until someone recreates a field, after
 * which the script would write to a dead id and report success.
 *
 * Cost note: this deliberately reads each issue's project card through the
 * sub-issue query rather than calling `gh project item-list`, which pages the
 * whole board and is expensive enough to exhaust the GraphQL point budget when
 * the sync is run repeatedly.
 *
 * Usage:
 *   node scripts/sync-stories-to-github.mjs            # dry run — prints the diff
 *   node scripts/sync-stories-to-github.mjs --apply    # write the differences
 *
 * Requires `gh` authenticated with the `project` scope.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'Keeping-History/rt911'
const [OWNER, NAME] = REPO.split('/')
const PARENT_ISSUE = 444 // "Radio Traffic" — the epic every story issue hangs off
const PROJECT_NUMBER = '3' // "9/11/2026 Release Planning"
const STORIES_DIR = 'stories'

const ISSUE_LABEL = 'enhancement'
const ISSUE_TYPE = 'Feature'
const ASSIGNEE = 'robbiebyrd'
const ISSUE_PRIORITY = 'High'
const EFFORT_DEFAULT = 'Medium'

/**
 * How a story's status projects onto GitHub. `start: true` means the work has
 * begun, so the issue gets a Start date; no story status maps to the project's
 * "In review" column.
 */
const STORY_RULES = {
  pending:     { state: 'OPEN',   reason: null,          start: false, column: 'Backlog' },
  ready:       { state: 'OPEN',   reason: null,          start: false, column: 'Ready' },
  blocked:     { state: 'OPEN',   reason: null,          start: false, column: 'Backlog' },
  in_progress: { state: 'OPEN',   reason: null,          start: true,  column: 'In progress' },
  complete:    { state: 'CLOSED', reason: 'completed',   start: true,  column: 'Done' },
  wontfix:     { state: 'CLOSED', reason: 'not_planned', start: false, column: 'Done' },
}

/** Effort is a 3-point scale and Size a 5-point one; XS and XL are left spare. */
const SIZE_FOR_EFFORT = { Low: 'S', Medium: 'M', High: 'L' }

const APPLY = process.argv.includes('--apply')

// Local dates, deliberately not `toISOString()`: that is UTC, and after ~19:00
// ET it reports tomorrow, giving one issue a date a day off from the rest.
const TODAY = new Date().toLocaleDateString('en-CA')
const TOMORROW = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA')

/** Raised for conditions worth reporting in one line instead of a stack trace. */
class SyncError extends Error {}

function gh(args, input) {
  try {
    return execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64e6 }).trim()
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (/rate limit/i.test(output)) {
      throw new SyncError(`GitHub API rate limit exhausted.\n${rateLimitHint()}`)
    }
    throw new SyncError(`gh ${args.slice(0, 3).join(' ')}… failed:\n${output.trim()}`)
  }
}
const ghJson = (args, input) => JSON.parse(gh(args, input))

/** Best-effort reset time; never let the hint itself become the failure. */
function rateLimitHint() {
  try {
    const { resources } = JSON.parse(execFileSync('gh', ['api', 'rate_limit'], { encoding: 'utf8' }))
    const minutes = Math.max(0, Math.ceil((resources.graphql.reset * 1000 - Date.now()) / 60_000))
    return `GraphQL resets in ${minutes} min (${new Date(resources.graphql.reset * 1000).toISOString()}). Re-run then.`
  } catch {
    return 'Re-run once the hourly GraphQL budget resets.'
  }
}

// --------------------------------------------------------------------------
// Reading

/** Pull a `## Heading` section's body out of a story file. */
const section = (md, heading) =>
  md.match(new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |\\Z)`, 'm'))?.[1].trim() ?? ''

/** Story id -> everything needed to sync, or to create the issue from scratch. */
function readStories() {
  const stories = new Map()
  for (const file of readdirSync(STORIES_DIR).filter((f) => f.endsWith('.md'))) {
    const md = readFileSync(join(STORIES_DIR, file), 'utf8')
    const frontMatter = md.match(/^---\n([\s\S]*?)\n---/)?.[1]
    if (!frontMatter) throw new Error(`${file}: no front matter`)

    const id = frontMatter.match(/^id:\s*"?([^"\n]+)"?/m)?.[1]?.trim()
    const status = frontMatter.match(/^status:\s*(\S+)/m)?.[1]?.trim()
    const title = frontMatter.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1]?.trim()
    if (!id || !status || !title) throw new Error(`${file}: missing id, status or title`)

    const files = section(md, 'Files')
    const body = [
      section(md, 'Problem Statement'),
      '',
      '## Acceptance criteria',
      '',
      section(md, 'Acceptance Criteria'),
      files ? `\n## Files\n\n${files}` : '',
      '',
      '---',
      `Tracked locally as story \`${id}\` (\`${STORIES_DIR}/${file}\`).`,
    ].join('\n')

    stories.set(id, { status, file, title, body })
  }
  return stories
}

/** Org-level issue fields, resolved by name, with their single-select options. */
function readIssueFields() {
  const query = `{repository(owner:"${OWNER}",name:"${NAME}"){issueFields(first:50){nodes{__typename
    ... on IssueFieldDate{id name}
    ... on IssueFieldSingleSelect{id name options{id name}}}}}}`
  const nodes = ghJson(['api', 'graphql', '-f', `query=${query}`]).data.repository.issueFields.nodes

  const pick = (name) => {
    const field = nodes.find((n) => n.name === name)
    if (!field) throw new Error(`${REPO} has no "${name}" issue field`)
    return { id: field.id, options: new Map((field.options ?? []).map((o) => [o.name, o.id])) }
  }
  return { startDate: pick('Start date'), targetDate: pick('Target date'), priority: pick('Priority'), effort: pick('Effort') }
}

/** Project id plus the option ids for the two single-selects we write. */
function readProjectFields() {
  const project = ghJson(['project', 'view', PROJECT_NUMBER, '--owner', OWNER, '--format', 'json'])
  const { fields } = ghJson(['project', 'field-list', PROJECT_NUMBER, '--owner', OWNER, '--format', 'json'])

  const pick = (name) => {
    const field = fields.find((f) => f.name === name)
    if (!field) throw new Error(`project ${PROJECT_NUMBER} has no "${name}" field`)
    return { id: field.id, options: new Map((field.options ?? []).map((o) => [o.name, o.id])) }
  }
  return { projectId: project.id, status: pick('Status'), size: pick('Size') }
}

/**
 * Story id -> live issue state, for every sub-issue of the epic. The project
 * card comes back on the same query so the board never has to be paged.
 */
function readIssues() {
  const query = `{repository(owner:"${OWNER}",name:"${NAME}"){issue(number:${PARENT_ISSUE}){
    subIssues(first:100){nodes{ number id state body
      issueFieldValues(first:20){nodes{__typename
        ... on IssueFieldSingleSelectValue{field{... on IssueFieldSingleSelect{name}} value}
        ... on IssueFieldDateValue{field{... on IssueFieldDate{name}} value}}}
      projectItems(first:5){nodes{ id project{number}
        fieldValues(first:20){nodes{__typename
          ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{name}}}}}}}}}}}}`
  const nodes = ghJson(['api', 'graphql', '-f', `query=${query}`])
    .data.repository.issue.subIssues.nodes

  const issues = new Map()
  for (const node of nodes) {
    const storyId = node.body.match(/story `([0-9]{3}-[0-9a-f]{4})`/)?.[1]
    if (!storyId) continue // a sub-issue that did not come from a story file

    const values = Object.fromEntries(
      node.issueFieldValues.nodes.filter((v) => v.field?.name).map((v) => [v.field.name, v.value]),
    )
    const item = node.projectItems.nodes.find((i) => i.project.number === Number(PROJECT_NUMBER))
    const card = item && Object.fromEntries(
      item.fieldValues.nodes.filter((v) => v.field?.name).map((v) => [v.field.name, v.name]),
    )

    issues.set(storyId, {
      number: node.number,
      nodeId: node.id,
      state: node.state,
      startDate: values['Start date'],
      effort: values.Effort,
      item: item && { id: item.id, status: card.Status, size: card.Size },
    })
  }
  return issues
}

// --------------------------------------------------------------------------
// Diffing

/** Everything that differs between the story files and GitHub. */
function diff(stories, issues, project) {
  const actions = []
  for (const [storyId, story] of [...stories].sort()) {
    const want = STORY_RULES[story.status]
    if (!want) throw new Error(`${story.file}: unhandled story status "${story.status}"`)

    const issue = issues.get(storyId)
    if (!issue) {
      actions.push({ storyId, story, want, steps: [{ kind: 'create', label: `create issue (Effort defaults to ${EFFORT_DEFAULT})` }] })
      continue
    }

    const steps = []
    if (issue.state !== want.state) {
      steps.push({ kind: 'state', to: want.state, reason: want.reason, label: `state ${issue.state}->${want.state}` })
    }
    if (want.start && !issue.startDate) steps.push({ kind: 'startDate', label: `+Start ${TODAY}` })
    if (!want.start && issue.startDate) steps.push({ kind: 'clearStartDate', label: '-Start' })

    if (!issue.item) {
      steps.push({ kind: 'addToProject', label: `add to project ${PROJECT_NUMBER}` })
    } else {
      const wantSize = SIZE_FOR_EFFORT[issue.effort]
      if (!wantSize) {
        steps.push({ kind: 'note', label: `Effort is ${issue.effort ?? 'unset'} — cannot derive Size` })
      } else if (issue.item.size !== wantSize) {
        steps.push({ kind: 'projectField', itemId: issue.item.id, field: project.size, option: wantSize, label: `Size ${issue.item.size ?? '(unset)'}->${wantSize}` })
      }
      if (issue.item.status !== want.column) {
        steps.push({ kind: 'projectField', itemId: issue.item.id, field: project.status, option: want.column, label: `Status ${issue.item.status ?? '(unset)'}->${want.column}` })
      }
    }

    if (steps.length) actions.push({ storyId, story, want, number: issue.number, nodeId: issue.nodeId, steps })
  }
  return actions
}

// --------------------------------------------------------------------------
// Writing

const setIssueFields = (issueId, fields) =>
  gh(['api', 'graphql', '-f',
      `query=mutation{setIssueFieldValue(input:{issueId:"${issueId}",issueFields:[${fields.join(',')}]}){clientMutationId}}`])

const selectOption = (field, name) => {
  const id = field.options.get(name)
  if (!id) throw new Error(`no option "${name}" on that field`)
  return id
}

const setProjectField = (projectId, itemId, field, option) =>
  gh(['project', 'item-edit', '--id', itemId, '--project-id', projectId,
      '--field-id', field.id, '--single-select-option-id', selectOption(field, option)])

/**
 * Create the issue and everything hanging off it: type, label, assignee, the
 * issue fields, the parent link, and its project card in the right column.
 */
function createIssue(action, { project, issueFields }) {
  const { story, want } = action
  const url = gh(['issue', 'create', '--repo', REPO, '--title', story.title, '--body-file', '-',
                  '--label', ISSUE_LABEL, '--assignee', ASSIGNEE], story.body)
  const number = Number(url.split('/').pop())
  const issue = ghJson(['api', `repos/${REPO}/issues/${number}`])

  gh(['api', '-X', 'PATCH', `repos/${REPO}/issues/${number}`, '-f', `type=${ISSUE_TYPE}`])

  const fields = [
    `{fieldId:"${issueFields.priority.id}",singleSelectOptionId:"${selectOption(issueFields.priority, ISSUE_PRIORITY)}"}`,
    `{fieldId:"${issueFields.effort.id}",singleSelectOptionId:"${selectOption(issueFields.effort, EFFORT_DEFAULT)}"}`,
    `{fieldId:"${issueFields.targetDate.id}",dateValue:"${TOMORROW}"}`,
  ]
  if (want.start) fields.push(`{fieldId:"${issueFields.startDate.id}",dateValue:"${TODAY}"}`)
  setIssueFields(issue.node_id, fields)

  gh(['api', '-X', 'POST', `repos/${REPO}/issues/${PARENT_ISSUE}/sub_issues`, '-F', `sub_issue_id=${issue.id}`])

  const item = ghJson(['project', 'item-add', PROJECT_NUMBER, '--owner', OWNER, '--url', url, '--format', 'json'])
  setProjectField(project.projectId, item.id, project.status, want.column)
  setProjectField(project.projectId, item.id, project.size, SIZE_FOR_EFFORT[EFFORT_DEFAULT])

  if (want.state === 'CLOSED') gh(['issue', 'close', String(number), '--repo', REPO, '--reason', want.reason])
  return number
}

function apply(action, context) {
  for (const step of action.steps) {
    switch (step.kind) {
      case 'create':
        action.number = createIssue(action, context)
        break
      case 'state':
        if (step.to === 'CLOSED') gh(['issue', 'close', String(action.number), '--repo', REPO, '--reason', step.reason])
        else gh(['issue', 'reopen', String(action.number), '--repo', REPO])
        break
      case 'startDate':
        setIssueFields(action.nodeId, [`{fieldId:"${context.issueFields.startDate.id}",dateValue:"${TODAY}"}`])
        break
      case 'clearStartDate':
        setIssueFields(action.nodeId, [`{fieldId:"${context.issueFields.startDate.id}",delete:true}`])
        break
      case 'addToProject': {
        const url = `https://github.com/${REPO}/issues/${action.number}`
        const item = ghJson(['project', 'item-add', PROJECT_NUMBER, '--owner', OWNER, '--url', url, '--format', 'json'])
        setProjectField(context.project.projectId, item.id, context.project.status, action.want.column)
        break
      }
      case 'projectField':
        setProjectField(context.project.projectId, step.itemId, step.field, step.option)
        break
      case 'note':
        break // reported, not actionable from here
    }
  }
}

// --------------------------------------------------------------------------

function main() {
  const stories = readStories()
  const issueFields = readIssueFields()
  const project = readProjectFields()
  const issues = readIssues()

  const actions = diff(stories, issues, project)
  if (!actions.length) {
    console.log(`In sync — ${stories.size} stories match their issues and project fields.`)
    return
  }

  for (const a of actions) {
    console.log(`${a.storyId}  #${a.number ?? '-'}  ${a.story.status.padEnd(11)}  ${a.steps.map((s) => s.label).join('; ')}`)
  }
  console.log(`\n${actions.length} of ${stories.size} stories differ.${APPLY ? ' Applying…' : ' Dry run — pass --apply to write.'}`)
  if (!APPLY) return

  const created = []
  for (const action of actions) {
    apply(action, { project, issueFields })
    if (action.steps.some((s) => s.kind === 'create')) created.push(action.number)
    console.log(`+ ${action.storyId} #${action.number} ${action.steps.map((s) => s.label).join('; ')}`)
  }
  console.log(`\n${actions.length} issue(s) updated. Re-run without --apply to confirm.`)
  if (created.length) {
    console.log(`Effort was defaulted to ${EFFORT_DEFAULT} on ${created.map((n) => `#${n}`).join(', ')} — adjust in GitHub and re-run to update Size.`)
  }
}

try {
  main()
} catch (error) {
  if (!(error instanceof SyncError)) throw error
  console.error(`\n${error.message}`)
  process.exit(1)
}
