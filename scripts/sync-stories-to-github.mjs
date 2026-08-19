#!/usr/bin/env node
/**
 * sync-stories-to-github.mjs — make GitHub reflect the local story files.
 *
 * `stories/*.md` is the source of truth for what is being worked on; the wiz
 * stories CLI rewrites a story's `status:` (and its filename) as work moves.
 * GitHub knows nothing about that, so the issues under the tracking epic and
 * their project card drift out of date within hours. This script closes that
 * gap in one direction only: stories are read, GitHub is written. It never
 * edits a story file.
 *
 * It is declarative, not incremental. Every run fetches live GitHub state,
 * computes what each issue *should* look like from the story files, and writes
 * only the differences. That makes it safe to re-run at any point — a no-op run
 * prints "In sync" — and it means an issue someone edited by hand gets pulled
 * back in line rather than double-applied.
 *
 * What it syncs, and from where:
 *
 *   issue open/closed  <- story status   (complete/wontfix close the issue)
 *   Start date         <- story status   (in_progress and complete get today)
 *   project Status     <- story status   (see STORY_RULES)
 *   project Size       <- issue Effort   (see SIZE_FOR_EFFORT)
 *
 * Effort itself is a human judgement, so it is read from the issue rather than
 * derived — set it in the GitHub UI and Size follows on the next run.
 *
 * What it does NOT do: create issues. An issue is matched to its story by the
 * `Tracked locally as story `NNN-hhhh`` marker in the issue body, and a story
 * with no such issue is reported as "NO ISSUE" for a human to deal with. The
 * initial creation was a one-off; drift is the recurring problem.
 *
 * Field and option IDs are resolved by name at runtime. Hardcoding the opaque
 * `PVTSSF_…`/`IFD_…` ids would work until someone recreates a field, at which
 * point the script would write to a dead id and appear to succeed.
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
const OWNER = REPO.split('/')[0]
const PARENT_ISSUE = 444 // "Radio Traffic" — the epic every story issue hangs off
const PROJECT_NUMBER = '3' // "9/11/2026 Release Planning"
const STORIES_DIR = 'stories'

/**
 * How a story's status projects onto GitHub. `start: true` means the work has
 * begun, so the issue gets a Start date; there is no story status that maps to
 * the project's "In review" column.
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

// Local date, deliberately not `toISOString()`: that is UTC, and after ~20:00
// ET it reports tomorrow, giving one issue a Start date a day off from the rest.
const TODAY = new Date().toLocaleDateString('en-CA')

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64e6 }).trim()
const ghJson = (args) => JSON.parse(gh(args))

/** Story id -> status, straight from the front matter of each story file. */
function readStories() {
  const stories = new Map()
  for (const file of readdirSync(STORIES_DIR).filter((f) => f.endsWith('.md'))) {
    const md = readFileSync(join(STORIES_DIR, file), 'utf8')
    const frontMatter = md.match(/^---\n([\s\S]*?)\n---/)?.[1]
    if (!frontMatter) throw new Error(`${file}: no front matter`)
    const id = frontMatter.match(/^id:\s*"?([^"\n]+)"?/m)?.[1]?.trim()
    const status = frontMatter.match(/^status:\s*(\S+)/m)?.[1]?.trim()
    if (!id || !status) throw new Error(`${file}: missing id or status`)
    stories.set(id, { status, file })
  }
  return stories
}

/** The org-level issue fields, resolved by name so ids stay out of this file. */
function readIssueFields() {
  const query = `{repository(owner:"${OWNER}",name:"${REPO.split('/')[1]}"){issueFields(first:50){nodes{
    __typename ... on IssueFieldDate{id name} ... on IssueFieldSingleSelect{id name}}}}}`
  const nodes = ghJson(['api', 'graphql', '-f', `query=${query}`]).data.repository.issueFields.nodes
  const byName = new Map(nodes.filter((n) => n.name).map((n) => [n.name, n.id]))
  const startDate = byName.get('Start date')
  if (!startDate) throw new Error('no "Start date" issue field on this repository')
  return { startDate }
}

/** Project id plus the option ids for the two single-selects we write. */
function readProjectFields() {
  const project = ghJson(['project', 'view', PROJECT_NUMBER, '--owner', OWNER, '--format', 'json'])
  const fields = ghJson(['project', 'field-list', PROJECT_NUMBER, '--owner', OWNER, '--format', 'json']).fields

  const pick = (name) => {
    const field = fields.find((f) => f.name === name)
    if (!field) throw new Error(`project ${PROJECT_NUMBER} has no "${name}" field`)
    return { id: field.id, options: new Map((field.options ?? []).map((o) => [o.name, o.id])) }
  }
  return { projectId: project.id, status: pick('Status'), size: pick('Size') }
}

/** Story id -> live issue state, for every sub-issue of the epic. */
function readIssues() {
  const query = `{repository(owner:"${OWNER}",name:"${REPO.split('/')[1]}"){issue(number:${PARENT_ISSUE}){
    subIssues(first:100){nodes{ number id state body
      issueFieldValues(first:20){nodes{ __typename
        ... on IssueFieldSingleSelectValue{ field{... on IssueFieldSingleSelect{name}} value }
        ... on IssueFieldDateValue{ field{... on IssueFieldDate{name}} value }}}}}}}}`
  const nodes = ghJson(['api', 'graphql', '-f', `query=${query}`])
    .data.repository.issue.subIssues.nodes

  const issues = new Map()
  for (const node of nodes) {
    const storyId = node.body.match(/story `([0-9]{3}-[0-9a-f]{4})`/)?.[1]
    if (!storyId) continue // a sub-issue that did not come from a story file
    // Date-valued nodes only carry `field` when the query asked for it; guard anyway.
    const values = Object.fromEntries(
      node.issueFieldValues.nodes.filter((v) => v.field?.name).map((v) => [v.field.name, v.value]),
    )
    issues.set(storyId, {
      number: node.number,
      nodeId: node.id,
      state: node.state,
      startDate: values['Start date'],
      effort: values.Effort,
    })
  }
  return issues
}

/** Everything that differs between the story files and GitHub. */
function diff({ stories, issues, projectItems, project }) {
  const actions = []
  for (const [storyId, { status, file }] of [...stories].sort()) {
    const want = STORY_RULES[status]
    if (!want) throw new Error(`${file}: unhandled story status "${status}"`)

    const issue = issues.get(storyId)
    if (!issue) { actions.push({ storyId, status, blocked: 'NO ISSUE — create one by hand' }); continue }

    const steps = []
    if (issue.state !== want.state) {
      steps.push({ kind: 'state', to: want.state, reason: want.reason, label: `state ${issue.state}->${want.state}` })
    }
    if (want.start && !issue.startDate) steps.push({ kind: 'startDate', label: `+Start ${TODAY}` })
    if (!want.start && issue.startDate) steps.push({ kind: 'clearStartDate', label: '-Start' })

    const item = projectItems.get(issue.number)
    if (!item) {
      steps.push({ kind: 'note', label: `NOT ON PROJECT ${PROJECT_NUMBER} — add it by hand` })
    } else {
      const wantSize = SIZE_FOR_EFFORT[issue.effort]
      if (!wantSize) {
        steps.push({ kind: 'note', label: `Effort is ${issue.effort ?? 'unset'} — cannot derive Size` })
      } else if (item.size !== wantSize) {
        steps.push({ kind: 'projectField', itemId: item.id, field: project.size, option: wantSize, label: `Size ${item.size ?? '(unset)'}->${wantSize}` })
      }
      if (item.status !== want.column) {
        steps.push({ kind: 'projectField', itemId: item.id, field: project.status, option: want.column, label: `Status ${item.status ?? '(unset)'}->${want.column}` })
      }
    }

    if (steps.length) actions.push({ storyId, status, number: issue.number, nodeId: issue.nodeId, steps })
  }
  return actions
}

function apply(action, { project, issueFields }) {
  for (const step of action.steps) {
    switch (step.kind) {
      case 'state':
        if (step.to === 'CLOSED') gh(['issue', 'close', String(action.number), '--repo', REPO, '--reason', step.reason])
        else gh(['issue', 'reopen', String(action.number), '--repo', REPO])
        break
      case 'startDate':
        setIssueField(action.nodeId, `{fieldId:"${issueFields.startDate}",dateValue:"${TODAY}"}`)
        break
      case 'clearStartDate':
        setIssueField(action.nodeId, `{fieldId:"${issueFields.startDate}",delete:true}`)
        break
      case 'projectField': {
        const optionId = step.field.options.get(step.option)
        if (!optionId) throw new Error(`no option "${step.option}" on that project field`)
        gh(['project', 'item-edit', '--id', step.itemId, '--project-id', project.projectId,
            '--field-id', step.field.id, '--single-select-option-id', optionId])
        break
      }
      case 'note':
        break // reported, not actionable from here
    }
  }
}

const setIssueField = (issueId, field) =>
  gh(['api', 'graphql', '-f',
      `query=mutation{setIssueFieldValue(input:{issueId:"${issueId}",issueFields:[${field}]}){clientMutationId}}`])

function main() {
  const stories = readStories()
  const issueFields = readIssueFields()
  const project = readProjectFields()
  const issues = readIssues()
  const projectItems = new Map(
    ghJson(['project', 'item-list', PROJECT_NUMBER, '--owner', OWNER, '--format', 'json', '--limit', '500'])
      .items.filter((i) => i.content?.number).map((i) => [i.content.number, i]),
  )

  const actions = diff({ stories, issues, projectItems, project })
  if (!actions.length) {
    console.log(`In sync — ${stories.size} stories match their issues and project fields.`)
    return
  }

  for (const a of actions) {
    const detail = a.blocked ?? a.steps.map((s) => s.label).join('; ')
    console.log(`${a.storyId}  #${a.number ?? '-'}  ${a.status.padEnd(11)}  ${detail}`)
  }
  console.log(`\n${actions.length} of ${stories.size} stories differ.${APPLY ? ' Applying…' : ' Dry run — pass --apply to write.'}`)
  if (!APPLY) return

  let written = 0
  for (const action of actions) {
    if (action.blocked) { console.log(`! ${action.storyId} skipped: ${action.blocked}`); continue }
    apply(action, { project, issueFields })
    console.log(`+ ${action.storyId} #${action.number} ${action.steps.map((s) => s.label).join('; ')}`)
    written += 1
  }
  console.log(`\n${written} issue(s) updated. Re-run without --apply to confirm.`)
}

main()
