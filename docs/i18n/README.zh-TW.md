<h1 align="center">Synch</h1>

<p align="center">為 Obsidian 提供端對端加密同步。</p>

<p align="center">
  <a href="https://synch.run/zh-tw">網站</a> ·
  <a href="https://synch.run/zh-tw/self-hosting">Cloudflare 部署</a> ·
  <a href="https://synch.run/zh-tw/self-hosting-docker">Docker 部署</a>
</p>

<p align="center">
  <a href="https://obsidian.md/plugins?id=synch"><img alt="Obsidian 社群外掛" src="https://img.shields.io/badge/Obsidian-Community%20Plugin-7c3aed?style=flat-square" /></a>
  <a href="../../LICENSE"><img alt="MIT 授權條款" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://synch.run/zh-tw"><img alt="Synch 概覽" src="../../.github/assets/synch-preview.webp" /></a>
</p>

---

透過本機加密、版本記錄和安全的衝突檔案處理，讓你的 Obsidian 資料庫在多個裝置之間
保持同步。

Synch 是獨立的社群外掛程式與服務，與 Obsidian 沒有關聯。

## 為什麼選擇 Synch？

- **以隱私為核心的設計** — 資料庫資料會在上傳前於你的裝置上加密。
- **快速同步** — 頻繁偵測變更並在裝置之間同步。
- **可復原** — 從加密記錄中復原先前版本和已刪除的檔案。
- **安全處理衝突** — 不重疊的 Markdown 編輯可以自動合併。
- **自由選擇託管方式** — 使用 Synch Cloud，或執行自己的 Synch 伺服器。

## 運作方式

```mermaid
flowchart LR
    device["你的裝置"] --> encrypt["在本機加密資料庫資料"]
    encrypt --> server["Synch Cloud 或自託管伺服器"]
    server --> other["在另一台裝置下載並解密"]
```

同步服務會儲存加密的檔案 blob 和加密的同步中繼資料。其設計目標是使託管服務無法
讀取你的明文筆記、明文檔案路徑或資料庫金鑰。

## Obsidian 同步選項比較

每種方案在便利性、控制權和設定成本之間都有不同的取捨。

| 選項 | 加密 | 儲存模式 | 衝突處理 | 適合對象 |
| --- | --- | --- | --- | --- |
| **Synch** | 裝置端 E2EE | Synch Cloud 或自託管 | 自動合併不重疊的 Markdown 編輯；保留重疊衝突 | 想要簡單、開源且注重隱私工作流程的使用者 |
| [Obsidian Sync](https://obsidian.md/sync) | 預設 E2EE；也可使用標準加密 | Obsidian 託管 | 官方 Obsidian 整合和同步記錄 | 偏好官方託管服務的使用者 |
| [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | E2EE | 自託管 CouchDB、物件儲存或可選 WebRTC | 自動合併簡單衝突 | 想最大程度控制後端的使用者 |
| [Remotely Save](https://github.com/remotely-save/remotely-save) | 可選的密碼式 E2EE | 你選擇的 S3、WebDAV、Dropbox、OneDrive、Google Drive 等儲存服務 | 基本衝突偵測；進階智慧衝突處理在 Pro 中提供 | 已有偏好儲存服務的使用者 |

此比較有意保持在較高層次。移轉重要資料庫前，請查看每個專案的最新文件和設定。

## 功能

- 近乎即時同步
- 加密的版本記錄
- 復原已刪除檔案
- 自動合併 Markdown 衝突
- 編輯重疊時建立衝突副本
- Markdown 檔案預設啟用
- 圖片、音訊、影片和 PDF 檔案預設啟用
- 額外的檔案和資料夾排除項目
- 託管的 Synch Cloud
- 用於自託管部署的自訂 API URL
- 支援桌面版和行動版 Obsidian

## 開始使用

### Synch Cloud

1. 在 Obsidian 中開啟 **設定 → Community plugins**。
2. 關閉受限模式並選擇 **Browse**。
3. 搜尋 **Synchrun**。
4. 安裝並啟用外掛程式。
5. 開啟 Synchrun 設定並登入。
6. 建立或連接遠端資料庫。

連接後，在 Synch 上傳本機變更並下載遠端變更期間，請保持 Obsidian 開啟。

### 自託管 Synch

Cloudflare 部署指南會將 Synch 部署到你自己的 Cloudflare 帳戶。如果不使用 Cloudflare，
請使用 Docker/systemd 指南。

你可以在以下環境執行 Synch：

- Cloudflare
- Docker
- 使用 systemd 的自有硬體

請參閱部署指南：

- [Cloudflare 部署](https://synch.run/zh-tw/self-hosting)
- [Docker/systemd 部署](https://synch.run/zh-tw/self-hosting-docker)

部署完成後，在外掛設定中設定自訂 API 基礎 URL。

## 安全提示

在進行以下操作前，請務必完整備份資料庫：

- 安裝新的同步服務
- 從其他同步方案移轉
- 變更加密設定
- 重設或重新連接遠端資料庫

除非你完全了解多個檔案監視器和衝突解決機制如何互動，否則不要在同一個資料庫上
執行多個同步服務。

### 揭露事項

<details>
<summary>展開揭露事項</summary>

本節提供給 Obsidian 開發者政策審查使用，也供希望在安裝前了解外掛行為的使用者參考。

### 帳戶需求

Synch 需要 Synch 帳戶才能使用託管同步服務。該帳戶用於驗證裝置、建立並連接遠端
資料庫、簽發同步權杖、執行儲存空間限制，以及管理服務存取權限。

### 網路使用

Synch 會透過 HTTPS 和 WebSocket 連接到已設定的 Synch API 基礎 URL。對於託管服務，
這是 Synch 營運的基礎設施。預設託管 API 端點為 `https://api.synch.run`，即時同步
使用 `wss://api.synch.run` WebSocket 連接。外掛會使用網路請求來：

- 登入並維持已驗證的裝置工作階段。
- 建立、列出和連接遠端資料庫。
- 上傳加密的檔案 blob 和加密的同步中繼資料。
- 下載加密的檔案 blob 和加密的同步中繼資料。
- 透過 WebSocket 連接交換即時同步訊息。
- 讀取帳戶、帳單、配額、儲存空間和同步狀態。

Synch 託管基礎設施使用第三方服務供應商，包括用於託管、儲存、網路、資料庫、佇列和
相關基礎設施的 Cloudflare。帳單由 Polar 處理。

### 傳送到 Synch 的資料

資料庫檔案內容和檔案路徑中繼資料會在上傳前於你的裝置上加密。Synch 儲存加密的
blob 和加密的同步中繼資料，其設計目標是使託管服務無法讀取你的明文筆記、明文檔案
路徑或明文資料庫金鑰。

端對端加密並不會隱藏所有營運中繼資料。Synch 可能會處理帳戶資訊、資料庫識別碼和
名稱、組織和成員記錄、本機資料庫識別碼、blob 識別碼、檔案大小、儲存空間使用量、
時間戳記、同步游標、工作階段資訊、IP 位址、User-Agent 字串、託管訂閱的帳單識別碼，
以及類似的營運中繼資料。

### 本機資料庫存取

Synch 會讀取和寫入目前 Obsidian 資料庫中的檔案，以同步所選資料庫檔案。它使用
Obsidian 的外掛資料 API 儲存外掛設定，使用 Obsidian 的 secret storage API 儲存裝置
工作階段權杖，並在瀏覽器 IndexedDB 中儲存本機同步狀態。

Synch 不會有意讀取或寫入目前 Obsidian 資料庫之外的檔案。

### 付款

託管服務提供免費和付費訂閱方案。目前付費託管方案為 Sync Starter，支援按月或按年
計費。付款處理和訂閱管理由 Polar 負責。

### 遙測、廣告和隱私

Synch Obsidian 外掛不包含用戶端遙測，也不會顯示廣告。託管服務可能會處理營運、保護、
疑難排解和改善服務所需的營運記錄和服務中繼資料。

詳情請閱讀託管服務的法律文件：

- [隱私權政策](https://synch.run/privacy)
- [服務條款](https://synch.run/terms)

</details>

## 參與貢獻

歡迎提交問題、錯誤報告、文件改進和提取要求。

## 授權條款

Synch 基於 [MIT 授權條款](../../LICENSE) 開源。
