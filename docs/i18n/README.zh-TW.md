# Synch

Synch 是一款 Obsidian Sync 替代方案，用於端對端加密的資料庫同步。

Synch 是獨立的社群外掛程式與服務，與 Obsidian 沒有關聯。

網站：[https://synch.run/zh-tw](https://synch.run/zh-tw)

翻譯: [English](../../README.md) · [한국어](README.ko.md) ·
[日本語](README.ja.md) · [简体中文](README.zh-CN.md)

## 安裝

1. 在 Obsidian 中開啟 **設定** → **Community plugins**。
2. 關閉受限模式，然後選擇 **Browse**。
3. 搜尋 **Synchrun**，選取後點擊 **Install**。
4. 安裝完成後，啟用 **Synchrun**。

## 功能

- **近乎即時同步：** Synch 會頻繁檢查變更，讓編輯內容可在裝置之間近乎即時地
  同步。
- **版本記錄：** 可透過同步檔案的加密記錄，復原誤改的內容。
- **復原已刪除檔案：** 已刪除的筆記和附件只要仍保留在版本記錄中，就可以找回。
- **自動合併衝突：** 當同一篇 Markdown 筆記在多台裝置上被修改時，Synch 會自動
  合併不同部分的編輯。若同一部分的編輯重疊，則會建立 conflict file，確保內容不會
  遺失。

## 如何使用 Synch

1. 安裝並啟用外掛。
2. 在 Obsidian 中開啟 Synch 設定。
3. 從外掛登入 Synch 帳戶。
4. 建立或連接遠端資料庫。
5. 在 Synch 上傳本機變更並下載遠端變更期間，保持 Obsidian 開啟。

Synch 預設會同步 Markdown 檔案。圖片、音訊、影片和 PDF 也預設啟用。其他檔案
類型預設停用，可在外掛設定中啟用。隱藏資料夾和隱藏檔案會被略過，你也可以在
設定中排除其他資料夾。

當同一路徑在不同裝置上發生不相容的變更時，Synch 會在資料庫中寫入衝突副本來
保留衝突內容，而不是默默捨棄內容。

外掛可以使用託管的 Synch Cloud API，也可以為自託管部署使用自訂 API 基礎 URL。

## 自託管

你可以在免費的 Cloudflare 帳戶上執行自己的 Synch 伺服器，並透過自訂伺服器 URL
連接 Obsidian 外掛。

請參閱自託管指南：
[https://synch.run/self-hosting](https://synch.run/self-hosting)

## 揭露事項

本節提供給 Obsidian 開發者政策審查使用，也供希望在安裝前了解外掛行為的使用者參考。

### 帳戶需求

Synch 需要 Synch 帳戶才能使用託管同步服務。該帳戶用於驗證裝置、建立並連接
遠端資料庫、簽發同步權杖、執行儲存空間限制，以及管理服務存取權限。

### 網路使用

Synch 會透過 HTTPS 和 WebSocket 連接到已設定的 Synch API 基礎 URL。對於託管
服務，這是 Synch 營運的基礎設施。預設託管 API 端點為 `https://api.synch.run`，
即時同步使用 `wss://api.synch.run` WebSocket 連接。外掛會使用網路請求來：

- 登入並維持已驗證的裝置工作階段。
- 建立、列出和連接遠端資料庫。
- 上傳加密的檔案 blob 和加密的同步中繼資料。
- 下載加密的檔案 blob 和加密的同步中繼資料。
- 透過 WebSocket 連接交換即時同步訊息。
- 讀取帳戶、帳單、配額、儲存空間和同步狀態。

Synch 託管基礎設施使用第三方服務供應商，包括用於託管、儲存、網路、資料庫、
佇列和相關基礎設施的 Cloudflare。帳單由 Polar 處理。

### 傳送到 Synch 的資料

資料庫檔案內容和檔案路徑中繼資料會在上傳前於你的裝置上加密。Synch 儲存加密的
blob 和加密的同步中繼資料，其設計目標是使託管服務無法讀取你的明文筆記、
明文檔案路徑或明文資料庫金鑰。

端對端加密並不會隱藏所有營運中繼資料。Synch 可能會處理帳戶資訊、資料庫識別碼
和名稱、組織和成員記錄、本機資料庫識別碼、blob 識別碼、檔案大小、儲存空間使用量、
時間戳記、同步游標、工作階段資訊、IP 位址、User-Agent 字串、託管訂閱的帳單識別碼，
以及類似的營運中繼資料。

### 本機資料庫存取

Synch 會讀取和寫入目前 Obsidian 資料庫中的檔案，以同步所選資料庫檔案。它使用
Obsidian 的外掛資料 API 儲存外掛設定，使用 Obsidian 的 secret storage API
儲存裝置工作階段權杖，並在瀏覽器 IndexedDB 中儲存本機同步狀態。

Synch 不會有意讀取或寫入目前 Obsidian 資料庫之外的檔案。

### 付款

託管服務提供免費和付費訂閱方案。目前付費託管方案為 Sync Starter，支援按月或
按年計費。付款處理和訂閱管理由 Polar 負責。

### 遙測、廣告和隱私

Synch Obsidian 外掛不包含用戶端遙測，也不會顯示廣告。託管服務可能會處理營運、
保護、疑難排解和改善服務所需的營運記錄和服務中繼資料。

詳情請閱讀託管服務的法律文件：

- [隱私權政策](https://synch.run/privacy)
- [服務條款](https://synch.run/terms)

### 原始碼

Synch 基於 MIT License 開源。外掛、託管 API 和網站的原始碼發布在本儲存庫中。
