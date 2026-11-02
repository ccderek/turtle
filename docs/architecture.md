# turtle — 架構設計（草案 v0.1）

> 狀態：討論中，尚未實作。標記 `TODO` 的部分為未決議題。

---

## 1. 背景與觀察

1. AI 產出 artifact 的速度遠超人類吸收速度，人類無法進行版本控管。
2. AI 會同時呼叫多個 agent 做不同的事；有些是實驗/拋棄式 code，有些不是，且每次 output 都不同（非確定性）。
3. AI 做的不一定是使用者要的，使用者需求也持續變化，同一份 code 會經歷多次轉向，難以版本管理。
4. 人機介面是線性的（chat），但 AI codegen 是樹狀展開；要管多個 branch 只能開多個對話、往上捲找分岔點。
5. 人類無法即時修改 AI 做錯的 branch，只能用對話介入，難以版控。

## 2. 目標

建立新的人機介面，讓人類能：

- **即時**看到並控管 AI 的進度（commit tree + 正在進行的 Thinking/Working）。
- 讓多個 AI **平行**處理，並管控每個 branch（fork / merge / kill / redirect / snapshot）。
- 在任一 branch 手動要求 AI **探索更多方案**並比較。
- 以正確的實作手段**節省整體 token 用量**。

## 3. 核心概念：兩棵樹

| 樹 | 內容 | 現況 |
|---|---|---|
| 程式碼狀態 DAG | 程式碼長什麼樣 | git 已解決 |
| 過程 / 意圖樹 | 誰、依什麼指示、想了什麼、花多少 token、為何分岔 | **無人處理** |

**turtle 的核心價值是把這兩棵樹連起來**：每個程式碼快照都能回答「它從哪個意圖來、當時的 context 是什麼」。

### 名詞

- **Node**：一個 checkpoint，等同一個 commit + 意圖/過程 metadata。
- **Micro snapshot**：每個 tool call 後自動拍的快照，預設在 UI 隱藏。
- **Semantic checkpoint**：有意義的階段點（AI 宣告或規則觸發），UI 預設顯示。
- **Exploration Group**：同一次 `explore` 產生的一組兄弟 branch。
- **Snapshot（人為標記）**：人類標記要保留、可被重用的 node。

---

## 4. 版控底層：為什麼是 git

### 4.1 git 原理（相關部分）

- **物件**：blob（檔案內容）、tree（目錄）、commit（tree + parent + metadata），全部以內容雜湊命名，**相同內容只存一份**，所以頻繁快照很便宜。
- **ref**：指向 commit 的可移動指標；歷史是 DAG。
- **worktree**：同一 repo 多個 checkout 共用物件庫 → 天然適合多 agent 隔離。
- **merge**：找 merge-base 做三方合併，只懂文字衝突、不懂語意。
- **不干擾使用者的快照**：
  `GIT_INDEX_FILE=<tmp> git add -A && git write-tree && git commit-tree <tree> -p <parent>`，再寫入 `refs/turtle/...`。

### 4.2 jj（Jujutsu）值得借用的語意

| jj 概念 | 對 turtle 的意義 |
|---|---|
| 工作目錄本身就是 commit、自動快照 | agent 每一步自動存檔 |
| change-id 與 commit-id 分離 | 人類改寫 node 後，node 身分不變 |
| operation log，可 undo 任何操作 | turtle 的事件日誌 + 全系統回到過去 |
| 衝突是一等公民，可先存著 | 平行 branch 不因衝突卡死 |
| 修改祖先 → 子孫自動 rebase | 人類修正中間 node，下游自動接上 |

### 4.3 候選比較

| 系統 | 評估 |
|---|---|
| Piper (Google) | 不開放。但 CitC「每次存檔即快照、雲端工作區」概念值得學 |
| jj | 概念最貼合；library API 尚不穩定，不綁死 |
| Sapling (Meta) | stacked commits 與互動式 UI (ISL) 值得參考；生態系小 |
| Pijul | patch 理論最漂亮；太不成熟，AI/工具鏈幾乎不認識 |
| **git** | ✅ 生態系最大、所有模型都熟、最終可直接產生 PR |

### 4.4 決策

**git 物件庫當儲存格式 + jj 語意當設計藍圖。**

turtle 需要的 5 項能力：

1. 便宜快照 → git ✅
2. 大量平行工作區 → git worktree ✅
3. 穩定的 node 身分 → turtle metadata 層
4. 操作日誌 / undo → turtle metadata 層
5. 衝突可延遲處理 → turtle metadata 層

3–5 無論用哪個 VCS 都得自己做，因此換 jj 收益有限，卻會失去生態系。

**規則：只有 orchestrator 能寫 git ref。** agent 只改檔案，避免多 agent 同時寫 ref 造成 lock 競爭與狀態不一致。

---

## 5. 資料模型

```ts
type NodeId = string;          // 穩定 ID（類似 jj change-id），內容改寫後不變

interface Node {
  id: NodeId;
  parents: NodeId[];           // 一般 1 個；merge node 為多個
  kind: "micro" | "semantic" | "human_edit" | "merge" | "root";
  commit: string;              // git commit sha（內容改寫後會變）
  tree: string;                // git tree sha（程式碼快照）

  intent: string;              // 這段要做什麼（人的指示或 AI 的計畫）
  summary: string;             // 給人看的摘要（= commit message）
  summarySource: "agent_declared" | "rule_auto";  // UI 區分顯示
  transcriptRef: TranscriptRef; // 到此為止的完整對話（fork / prompt cache 需要）
  artifacts: ArtifactRef[];    // 測試結果、截圖、log…
  verified: { tests?: "pass" | "fail" | "none"; diffStat: DiffStat };

  agentId: string | null;      // human_edit 時為 null
  status: "running" | "done" | "killed" | "failed" | "blocked" | "need_decision";
  tokens: { input: number; cachedInput: number; output: number };
  costUsd: number;

  tags: ("snapshot" | "throwaway" | "experiment")[];
  explorationGroupId?: string;
  createdAt: string;
}

interface Event {              // 類似 jj operation log，append-only
  id: string;
  at: string;
  actor: { type: "agent" | "human" | "system"; id: string };
  type:
    | "tool_call" | "checkpoint" | "fork" | "explore" | "kill"
    | "redirect" | "human_edit" | "merge" | "tag" | "rebase" | "gc";
  payload: unknown;
}
```

---

## 6. 系統架構

```
┌──────────────────── Web UI ─────────────────────┐
│ 待處理佇列 │ Tree 視圖 │ Node 詳情 │ 比較視圖 │ 即時串流 │
│ 操作：fork / explore / kill / redirect / merge / tag │
└──────────────▲───────────────────┬──────────────┘
               │ WebSocket（事件）  │ HTTP（指令）
┌──────────────┴───────────────────▼──────────────┐
│ Orchestrator（TypeScript daemon, 本機）           │
│  • Agent 生命週期：spawn / interrupt / kill        │
│  • Checkpoint 引擎：hook → 快照 → 摘要 → Node      │
│  • Context 組裝器：fork 時要給子 agent 什麼         │
│  • 探索流程：Plan → 人篩選 → Execute               │
│  • 預算控制：token / 平行數 / 樹深度上限            │
│  • 唯一的 git ref 寫入者                           │
└──────┬──────────────────────────┬───────────────┘
       │ Adapter 介面              │
┌──────▼────────────────┐  ┌──────▼──────────────────┐
│ Agent Runtime          │  │ Storage                 │
│ 每 agent 一個 container │  │ git 物件庫 refs/turtle/* │
│ + 一個 git worktree    │  │ SQLite：nodes / events  │
│ Claude Agent SDK (L2)  │  │ transcripts（內容定址）  │
│ 其他 agent (L0/L1)     │  │ artifacts               │
└────────────────────────┘  └─────────────────────────┘
```

### UI 原則

- **人的注意力才是瓶頸**。首頁是「待處理佇列」（`blocked` / `need_decision` / 測試失敗 / 預算警告），tree 是導覽工具。
- tree 預設只顯示 semantic checkpoint，可收合整段路徑；micro snapshot 按需展開。
- 「AI 宣稱的」與「實際驗證的」（測試、diffStat）分開顯示。
- 從任一 node fork 時顯示預估成本（cache 是否還有效）。

---

## 7. Checkpoint 機制

**決策：AI 宣告為主，規則保底。**

### 7.1 AI 宣告

turtle 以 MCP 工具提供：

```
turtle_checkpoint(
  summary: string,
  status: "progress" | "done" | "blocked" | "need_decision",
  artifacts?: ArtifactRef[]
)
```

System prompt 指引：完成一個子目標、要改變方向、需要人決策時呼叫。`blocked` / `need_decision` 直接進入待處理佇列。

### 7.2 規則保底

AI 長時間未宣告時自動補 checkpoint，觸發條件（任一）：

- 超過 N 個 tool call 或 M 分鐘
- 變動行數 / 檔案數超過門檻
- 測試狀態翻轉（fail→pass 或 pass→fail）

自動 checkpoint 由小模型（如 Haiku）依 diff + tool call 列表寫摘要，不餵完整 thinking；UI 以不同樣式標示。

### 7.3 Micro snapshot

每個 tool call 後自動拍，預設隱藏，用於細粒度回溯。

---

## 8. 操作語意

| 操作 | 語意 |
|---|---|
| **fork(node, 指示)** | 從 node 開新 branch，新 agent 接手 |
| **explore(node, 指示, N)** | 兩階段：① Plan：一個 agent 列出 N 個「真正不同」的方案（便宜）② 人篩選 ③ Execute：每 agent 一個方案，並告知兄弟在做什麼。產生 Exploration Group |
| **kill(agent)** | 在下一個 tool 邊界停止，最後狀態存為 node（status=killed） |
| **redirect(agent, 指示)** | 在 tool 邊界中斷，transcript 注入「方向已變更」訊息後繼續 |
| **human_edit(node)** | 人的修改成為一個 node（作者=human）；正在跑的下游 agent 在下一個 tool 邊界 rebase 到其上，**並把人的修改注入 agent context**，避免被改回去 |
| **merge(a, b)** | 本身是一個 agent 任務，產出 merge node，必須跑測試（處理語意衝突）。衝突可先存在 node 上延後處理 |
| **tag snapshot(node)** | 標記保留，不被 GC，可重用 |
| **export(node)** | 把 root→node 路徑整理成乾淨 git 歷史（可 squash），產生一般 branch / PR |

### 比較視圖

Exploration Group 的兄弟 branch 並排：diff、測試結果、程式碼大小、token 花費；操作：「選這個」、「合併 A 與 B 的優點」。

---

## 9. 多模型：Adapter 分級

核心（node / tree / VCS / UI）與模型無關；與模型綁定的只有 agent runtime 層。

| Level | 能力 | 適用 |
|---|---|---|
| **L0** 檔案系統監看 | 只看 worktree 變化做快照 | 任何 agent（Codex、Gemini CLI、Aider…） |
| **L1** 結構化事件 | hook / 事件串流，知道 tool call 邊界與 thinking | 有 hook 的 agent |
| **L2** 完全控制 | turtle 管 agent loop 與 transcript：任意 node fork、中斷、注入、prompt cache | Claude Agent SDK（第一個實作） |

各家差異：prompt cache 機制與 TTL、thinking 可見性（Claude thinking block 帶簽章，不可跨模型）、transcript 格式、中斷能力。

附帶功能：transcript 可轉中立格式，讓**另一個模型接手同一個 branch**（cache 失效、thinking 無法帶過去）。

---

## 10. 回滾範圍與執行環境

**決策：只回滾程式碼。前提：環境必須寫成程式碼。**

> 原則：程式碼 + 寫成程式碼的環境 = 完整狀態；沒寫進去的都可丟；不可逆的操作一定要人確認。

| 風險 | 對策 |
|---|---|
| 環境重建花時間（非 token），× 平行 agent 數 | 以 lockfile 雜湊為 key 快取 image / 依賴 |
| 資料庫 schema 與回滾後的程式碼不一致 | 每 worktree 一個一次性 DB（SQLite 檔 / Postgres template clone / container），從 seed 重建 |
| 不可逆外部副作用（email、付款、push、雲資源） | 攔截並要求人確認 |
| 未追蹤檔案（`.env`、產物） | 明確快照政策；機密絕不進快照 |
| 用 AI 重建環境會耗 token 且不確定 | 讓 AI 產出**確定性腳本**存進 repo，之後跑腳本 |

### 本機 container

- 每 agent 一個 container，只掛載 worktree 工作目錄，**不掛 `.git`**（防止 agent 繞過 orchestrator 寫 ref）。`git diff` / `git log` 等由 turtle MCP 工具提供。
- macOS bind mount I/O 慢：`node_modules` 等改用 named volume。
- API key 由 orchestrator 從 host 注入，不寫進 image。

---

## 11. Token 節省策略

1. **Fork 吃 prompt cache**：子 agent transcript 前綴與父完全相同 → 命中 cache（約一成價格）。因此 node 必須保存完整 transcript。
2. **Cache 過期的取捨**：cache 有 TTL（5 分鐘 / 1 小時）。過期後可選「摘要鏈」（便宜、失細節）或「完整 transcript」（準、貴），UI 顯示預估成本由人選。
3. **及早砍錯誤 branch**：即時可見 + 一鍵 kill 是最大的節省來源。
4. **避免重複探索**：fork / explore 時告知子 agent 兄弟已試過且失敗的方案（摘要）。
5. **摘要分層**：只在 semantic checkpoint 做摘要，用小模型。
6. **Explore 先 Plan 再 Execute**：便宜規劃，只執行人選中的方案。
7. **預算上限**：每個 branch / 整棵樹的 token、平行數、深度上限。

---

## 12. 技術選型

**TypeScript（Node.js 或 Bun）作為 orchestrator 與 Web UI 的語言。**

| 考量 | 說明 |
|---|---|
| Claude Agent SDK | TypeScript 是官方主力版本 |
| 前後端共用型別 | `Node` / `Event` 等型別一份定義 |
| 普及度 / AI 熟悉度 | 依 GitHub Octoverse 2025，TypeScript 是 GitHub 上使用人數最多的語言 |
| 效能 | 瓶頸是 LLM 延遲（秒級），不是 CPU；git 快照為毫秒級 |

快照引擎先直接呼叫 git plumbing 指令；若出現瓶頸，再將熱點改為 Rust（gitoxide + napi-rs）。

---

## 13. 擴展性（Scale-up）

**結論：真正的上限是人的注意力、API rate limit、本機 RAM（container 數），不是 TypeScript。** 但以下幾點要從一開始就設計對：

### 13.1 Node 數量（數千～數十萬）

| 層 | 問題 | 對策 |
|---|---|---|
| SQLite | 百萬列內無壓力 | 建好索引（parent、agent、status、explorationGroup）；之後可換 Postgres |
| git ref | **每個 node 一個 ref 會拖垮 git**（大量 loose ref） | 只對「branch 尖端」與「snapshot」建 ref；node 是尖端的祖先，自然可達；使用 packed-refs 或 reftable（git ≥ 2.45） |
| git GC | 沒有 ref 指向的 commit 會被 gc 清掉 | 被 kill 的 branch 保留尖端 ref 直到 turtle 自己的 GC 政策刪除 |
| git 物件 | 內容定址，重複內容自動去重 | 定期 `git repack` |

### 13.2 Transcript 體積

- 子 transcript = 父 transcript + 新增訊息 → **只存新增段落**（append-only 分段 + 指向父段落），fork 幾乎零儲存成本。
- 分段以內容雜湊存放於磁碟（之後可換 object storage）。

### 13.3 大型 repo 的快照速度

- `git add -A` 在大 repo 需掃描整個目錄樹。
- 對策：agent 透過工具寫檔時已知變動路徑 → 增量建 tree；bash 指令可能改任何檔案 → 開啟 fsmonitor / untracked cache 作後備。

### 13.4 UI

- 不推整棵樹，只推增量事件；diff、transcript 延遲載入。
- 樹狀圖虛擬化渲染 + 收合 + 依縮放程度調整細節。
- 多 agent token 串流以固定頻率（如 10Hz）批次推送。

### 13.5 Node.js 單執行緒

- orchestrator 幾乎全是 I/O（API 呼叫、git 子程序、檔案），單執行緒足夠。
- CPU 密集工作（大 diff 計算、樹狀佈局）放到 `worker_threads` 或交給瀏覽器端。

### 13.6 走向雲端 / 團隊（未來）

- 從一開始把 Storage 與 Agent Runtime 抽象成介面：SQLite→Postgres、本機檔案→object storage、本機 container→遠端 container。
- orchestrator 狀態盡量放在 DB，以便日後水平擴展。

---

## 14. 風險與未決問題

### 根本性

1. **checkpoint 粒度**：太細會重現觀察 1 → 兩層 checkpoint + 收合（§7）。
2. **人的注意力瓶頸**：待處理佇列優先於 tree（§6）。
3. **非程式碼狀態**：env-as-code + 不可逆操作攔截（§10）。

### 技術

4. 人與 AI 同時改同一 worktree 的 race condition（§8 human_edit）。
5. redirect 只能在 tool 邊界生效，且需注入 context。
6. 語意衝突的 merge（§8 merge）。
7. fork 時的 context 量：準確 vs 成本。
8. 摘要可能說謊 → 綁定客觀驗證（§5 `verified`）。

### 產品

9. 誰決定開平行 agent？AI 自行開分支需預算 / 深度上限。
10. 拋棄式 branch 與 transcript 的 GC 政策。`TODO`
11. 與現有工具（Claude Code checkpoint/rewind、subagents、Cursor background agents 等）的差異化定位。`TODO`

---

## 15. 分期計畫

| Phase | 範圍 | 驗證什麼 |
|---|---|---|
| **0 記錄** | CLI 包 Claude Agent SDK + worktree + container + hook + `turtle_checkpoint` MCP → 寫入 `refs/turtle/*` 與 SQLite | 資料模型、checkpoint 粒度 |
| **1 唯讀 UI** | Web：待處理佇列、tree、node 詳情（diff / summary / artifact）、即時串流 | 人能否跟上 AI |
| **2 控制** | kill / fork / redirect / human_edit / tag snapshot | 介入的時機與語意 |
| **3 探索與合併** | explore（Plan→篩選→Execute）、比較視圖、merge agent、export to git、跨 branch 失敗經驗傳遞、token 優化 | 平行探索的價值與成本 |

---

## 16. 決策紀錄

| # | 項目 | 決定 |
|---|---|---|
| D1 | 版控底層 | git 物件庫 + SQLite metadata，借用 jj 語意；orchestrator 為唯一 ref 寫入者 |
| D2 | 使用模式 | 監控/控制 + 探索，任一 branch 可手動 explore |
| D3 | 模型 | 通用 Adapter（L0/L1/L2），先做 Claude Agent SDK |
| D4 | 回滾範圍 | 只回滾程式碼；環境寫成程式碼 |
| D5 | 執行環境 | 前期本機 + 每 agent 一個 container |
| D6 | UI | Web |
| D7 | Checkpoint | AI 宣告為主，規則保底，micro snapshot 預設隱藏 |
| D8 | 語言 | TypeScript；Rust 僅於需要時用於熱點 |

## 17. TODO

- [ ] **Q4**：使用者的具體使用場景（用來從頭到尾走一次資料流，驗證架構）
- [ ] 使用者範圍：個人 vs 團隊（目前假設個人）
- [ ] 拋棄式 branch / transcript 的 GC 政策
- [ ] Node.js vs Bun
- [ ] 與現有工具的差異化定位
- [ ] Phase 0 的詳細規格（目錄結構、MCP 工具定義、SQLite schema）
