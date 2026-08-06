<h1 align="center">Synch</h1>

<p align="center">为 Obsidian 提供端到端加密同步。</p>

<p align="center">
  <a href="https://synch.run/zh-cn">网站</a> ·
  <a href="https://synch.run/zh-cn/self-hosting">Cloudflare 部署</a> ·
  <a href="https://synch.run/zh-cn/self-hosting-docker">Docker 部署</a>
</p>

<p align="center">
  <a href="https://obsidian.md/plugins?id=synch"><img alt="Obsidian 社区插件" src="https://img.shields.io/badge/Obsidian-Community%20Plugin-7c3aed?style=flat-square" /></a>
  <a href="../../LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://synch.run/zh-cn"><img alt="Synch 概览" src="../../.github/assets/synch-preview.webp" /></a>
</p>

---

通过本地加密、版本历史和安全的冲突文件处理，让你的 Obsidian 仓库在多个设备之间
保持同步。

Synch 是独立的社区插件和服务，与 Obsidian 没有关联。

## 为什么选择 Synch？

- **隐私优先设计** — 仓库数据会在上传前于你的设备上加密。
- **快速同步** — 频繁检测更改并在设备之间同步。
- **可恢复** — 从加密历史中恢复以前的版本和已删除的文件。
- **安全处理冲突** — 不重叠的 Markdown 编辑可以自动合并。
- **自由选择托管方式** — 使用 Synch Cloud，或运行自己的 Synch 服务器。

## 工作方式

```mermaid
flowchart LR
    device["你的设备"] --> encrypt["在本地加密仓库数据"]
    encrypt --> server["Synch Cloud 或自托管服务器"]
    server --> other["在另一台设备下载并解密"]
```

同步服务会存储加密的文件 blob 和加密的同步元数据。其设计目标是使托管服务无法
读取你的明文笔记、明文文件路径或仓库密钥。

## Obsidian 同步选项比较

每种方案在便利性、控制权和设置成本之间都有不同的取舍。

| 选项 | 加密 | 存储模式 | 冲突处理 | 适合人群 |
| --- | --- | --- | --- | --- |
| **Synch** | 设备端 E2EE | Synch Cloud 或自托管 | 自动合并不重叠的 Markdown 编辑；保留重叠冲突 | 希望使用简单、开源且注重隐私工作流的用户 |
| [Obsidian Sync](https://obsidian.md/sync) | 默认 E2EE；也可使用标准加密 | Obsidian 托管 | 官方 Obsidian 集成和同步历史 | 偏好官方托管服务的用户 |
| [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | E2EE | 自托管 CouchDB、对象存储或可选 WebRTC | 自动合并简单冲突 | 希望最大程度控制后端的用户 |
| [Remotely Save](https://github.com/remotely-save/remotely-save) | 可选的基于密码的 E2EE | 你选择的 S3、WebDAV、Dropbox、OneDrive、Google Drive 等存储 | 基本冲突检测；高级智能冲突处理在 Pro 中提供 | 已有偏好存储服务的用户 |

此比较有意保持在较高层次。迁移重要仓库前，请查看每个项目的最新文档和设置。

## 功能

- 近乎即时同步
- 加密的版本历史
- 恢复已删除文件
- 自动合并 Markdown 冲突
- 编辑重叠时创建冲突副本
- Markdown 文件默认启用
- 图片、音频、视频和 PDF 文件默认启用
- 额外的文件和文件夹排除项
- 托管的 Synch Cloud
- 用于自托管部署的自定义 API URL
- 支持桌面版和移动版 Obsidian

## 开始使用

### Synch Cloud

1. 在 Obsidian 中打开 **设置 → Community plugins**。
2. 关闭受限模式并选择 **Browse**。
3. 搜索 **Synchrun**。
4. 安装并启用插件。
5. 打开 Synchrun 设置并登录。
6. 创建或连接远程仓库。

连接后，在 Synch 上传本地更改并下载远程更改期间，请保持 Obsidian 打开。

### 自托管 Synch

Cloudflare 部署指南会将 Synch 部署到你自己的 Cloudflare 账户。如果不使用 Cloudflare，
请使用 Docker/systemd 指南。

你可以在以下环境运行 Synch：

- Cloudflare
- Docker
- 使用 systemd 的自有硬件

请参阅部署指南：

- [Cloudflare 部署](https://synch.run/zh-cn/self-hosting)
- [Docker/systemd 部署](https://synch.run/zh-cn/self-hosting-docker)

部署完成后，在插件设置中设置自定义 API 基础 URL。

## 安全提示

在进行以下操作前，请务必完整备份仓库：

- 安装新的同步服务
- 从其他同步方案迁移
- 更改加密设置
- 重置或重新连接远程仓库

除非你完全了解多个文件监视器和冲突解决机制如何交互，否则不要在同一个仓库上运行
多个同步服务。

### 披露

<details>
<summary>展开披露</summary>

本节供 Obsidian 开发者政策审核使用，也供希望在安装前了解插件行为的用户参考。

### 账户要求

使用托管同步服务需要 Synch 账户。该账户用于验证设备、创建并连接远程仓库、签发
同步令牌、执行存储限制，以及管理服务访问权限。

### 网络使用

Synch 通过 HTTPS 和 WebSocket 连接到已配置的 Synch API 基础 URL。对于托管服务，
该 URL 指向 Synch 运营的基础设施。默认托管 API 端点为 `https://api.synch.run`，
实时同步使用 `wss://api.synch.run` WebSocket 连接。插件会使用网络请求来：

- 登录并维持已认证的设备会话。
- 创建、列出和连接远程仓库。
- 上传加密的文件 blob 和加密的同步元数据。
- 下载加密的文件 blob 和加密的同步元数据。
- 通过 WebSocket 连接交换实时同步消息。
- 读取账户、账单、配额、存储和同步状态。

Synch 托管基础设施使用第三方服务提供商，包括用于托管、存储、网络、数据库、队列
和相关基础设施的 Cloudflare。账单由 Polar 处理。

### 发送到 Synch 的数据

仓库文件内容和文件路径元数据会在上传前于你的设备上加密。Synch 存储加密的 blob
和加密的同步元数据，其设计目标是使托管服务无法读取你的明文笔记、明文文件路径或
明文仓库密钥。

端到端加密并不会隐藏所有运行所需的元数据。Synch 可能会处理账户信息、仓库标识符和
名称、组织和成员记录、本地仓库标识符、blob 标识符、文件大小、存储使用量、时间戳、
同步游标、会话信息、IP 地址、User-Agent 字符串、托管订阅的账单标识符，以及类似的
运行元数据。

### 本地仓库访问

Synch 会读取和写入当前 Obsidian 仓库中的文件，以同步所选仓库文件。它使用 Obsidian
的插件数据 API 存储插件设置，使用 Obsidian 的 secret storage API 存储设备会话令牌，
并在浏览器 IndexedDB 中存储本地同步状态。

Synch 不会有意读取或写入当前 Obsidian 仓库之外的文件。

### 付款

托管服务提供免费和付费订阅方案。当前付费托管方案为 Sync Starter，支持按月或按年
计费。支付处理和订阅管理由 Polar 负责。

### 遥测、广告和隐私

Synch Obsidian 插件不包含客户端遥测，也不会显示广告。托管服务可能会处理运行、保护、
排查问题和改进服务所需的运行日志和服务元数据。

详情请阅读托管服务的法律文档：

- [隐私政策](https://synch.run/privacy)
- [服务条款](https://synch.run/terms)

</details>

## 参与贡献

欢迎提交问题、错误报告、文档改进和拉取请求。

## 许可证

Synch 基于 [MIT 许可证](../../LICENSE) 开源。
