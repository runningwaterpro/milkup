# Issue tracker: GitHub

Issue 和 spec 记录在 `runningwaterpro/milkup` 的 GitHub Issues。所有操作走 `gh` CLI。

## Conventions

- **建 issue**：`gh issue create --repo runningwaterpro/milkup --title "..." --body "..."`，多行正文用 heredoc。
- **读 issue**：`gh issue view <number> --repo runningwaterpro/milkup --comments`。
- **列 issue**：`gh issue list --repo runningwaterpro/milkup --state open --json number,title,body,labels --jq '[.[] | {number, title, body, labels: [.labels[].name]}]'`，配合 `--label` 与 `--state` 过滤。
- **评论**：`gh issue comment <number> --repo runningwaterpro/milkup --body "..."`
- **打标签 / 去标签**：`gh issue edit <number> --repo runningwaterpro/milkup --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --repo runningwaterpro/milkup --comment "..."`

`--repo runningwaterpro/milkup` 不能省：本仓库的 `origin` 指向的是上游 `Auto-Plugin/milkup`，省略时 `gh` 会推到上游去。

## Pull requests as a triage surface

**PRs as a request surface: no.**（本仓库不把 PR 当成需求入口；`/triage` 读这个标志。改成 `yes` 即可开启。）

开启后 PR 走与 issue 相同的标签与状态流转，用 `gh pr` 的等价命令：
`gh pr view <number> --comments`、`gh pr diff <number>`、`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`、`gh pr comment`、`gh pr edit --add-label/--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，裸写 `#42` 可能是其中之一：用 `gh pr view 42`，失败再回退到 `gh issue view 42`。

## When a skill says "publish to the issue tracker"

建一条 GitHub issue。

## When a skill says "fetch the relevant ticket"

`gh issue view <number> --repo runningwaterpro/milkup --comments`。
