#!/usr/bin/env bash
# <xbar.title>usage-lens</xbar.title>
# <xbar.desc>今天 / 本周 AI 编码工具 token 用量（本地日志，只读）</xbar.desc>
# <xbar.dependencies>node,jq</xbar.dependencies>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
CLI="${USAGE_LENS_CLI:-usage-lens}"
LOG="${TMPDIR:-/tmp}/usage-lens-swiftbar.log"

fail() { echo "— | sfimage=gauge.medium"; echo "---"; echo "$1 | color=gray"
         echo "刷新 | refresh=true"; echo "打开日志 | bash=/usr/bin/open param1=$LOG terminal=false"; exit 0; }
command -v jq >/dev/null || fail "缺少 jq（brew install jq）"
json="$($CLI --json 2>>"$LOG")" || fail "usage-lens 运行失败"
[ -n "$json" ] || fail "usage-lens 没有输出"

out="$(printf '%s' "$json" | jq -r --arg log "$LOG" '
def fmt: if . == null then "—" elif . >= 1e6 then "\((. / 1e5 | floor) / 10)M"
         elif . >= 1e3 then "\((. / 1e2 | floor) / 10)k" else tostring end;
def tot($w): .window[$w].metrics.total? // null;
def cnt: if type == "number" then . elif type == "array" then length else 0 end;
def short: [(.carriedFiles, .badLines, .badFrames) | cnt] | add > 0;
def ge: if short then "≥" else "" end;
(.sources // []) as $S
| ( .totals.lowerBound == true or
    ([$S[] | select(.availability == "unknown" or (.availability == "ok" and (short or tot("today") == null)))] | length > 0) ) as $partial
| tot("today") as $t
| (if $t == null then "—" else (if $partial then "≥" else "" end) + ($t | fmt) end) + " | sfimage=gauge.medium",
  "---",
  "今天 / 本周（本地时区） | color=gray size=11",
  ( $S[] | select(.availability != "not_installed")
    | (.label // .source // "?") as $n
    | if .availability != "ok" then "\($n)：—（未取到） | color=gray"
      elif tot("today") == null then "\($n)：—（累计型，暂无窗口） | color=gray"
      else "\($n)：\(ge)\(tot("today") | fmt) / \(ge)\(tot("week") | fmt)" end ),
  "---",
  "刷新 | refresh=true",
  "打开日志 | bash=/usr/bin/open param1=\($log) terminal=false"
' 2>>"$LOG")" || fail "usage-lens 输出解析失败（字段可能对不上）"
[ -n "$out" ] || fail "usage-lens 输出为空"
printf '%s\n' "$out"
