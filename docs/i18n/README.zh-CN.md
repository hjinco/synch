# Synch

Synch 是一款 Obsidian Sync 替代方案，用于端到端加密的仓库同步。

Synch 是独立的社区插件和服务，与 Obsidian 没有关联。

网站：[https://synch.run/zh-cn](https://synch.run/zh-cn)

翻译: [English](../../README.md) · [한국어](README.ko.md) ·
[日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

## 安装

1. 在 Obsidian 中打开 **设置** → **Community plugins**。
2. 关闭受限模式，然后选择 **Browse**。
3. 搜索 **Synchrun**，选择它并点击 **Install**。
4. 安装完成后，启用 **Synchrun**。

## 功能

- **近乎即时同步：** Synch 会频繁检查更改，让编辑内容可在设备之间近乎即时地
  同步。
- **版本历史：** 可通过同步文件的加密历史，恢复误改的内容。
- **恢复已删除文件：** 已删除的笔记和附件只要仍保留在版本历史中，就可以找回。
- **自动合并冲突：** 当同一篇 Markdown 笔记在多台设备上被修改时，Synch 会自动
  合并不同部分的编辑。若同一部分的编辑重叠，则会创建 conflict file，以确保内容
  不会丢失。

## 如何使用 Synch

1. 安装并启用插件。
2. 在 Obsidian 中打开 Synch 设置。
3. 从插件登录 Synch 账户。
4. 创建或连接远程仓库。
5. 在 Synch 上传本地更改并下载远程更改期间，保持 Obsidian 打开。

Synch 默认同步 Markdown 文件。图片、音频、视频和 PDF 也默认启用。其他文件
类型默认禁用，可在插件设置中启用。隐藏文件夹和隐藏文件会被跳过，你也可以在
设置中排除其他文件夹。

当同一路径在不同设备上发生不兼容的更改时，Synch 会在仓库中写入冲突副本来
保留冲突内容，而不是静默丢弃内容。

插件可以使用托管的 Synch Cloud API，也可以为自托管部署使用自定义 API 基础 URL。

## 自托管

你可以在免费的 Cloudflare 账户上运行自己的 Synch 服务器，并通过自定义服务器 URL
连接 Obsidian 插件。

请参阅自托管指南：
[https://synch.run/self-hosting](https://synch.run/self-hosting)

## 披露

本节供 Obsidian 开发者政策审核使用，也供希望在安装前了解插件行为的用户参考。

### 账户要求

Synch 需要 Synch 账户才能使用托管同步服务。该账户用于验证设备、创建并连接
远程仓库、签发同步令牌、执行存储限制，以及管理服务访问权限。

### 网络使用

Synch 通过 HTTPS 和 WebSocket 连接到已配置的 Synch API 基础 URL。对于托管
服务，该 URL 指向 Synch 运营的基础设施。默认托管 API 端点为
`https://api.synch.run`，实时同步使用 `wss://api.synch.run` WebSocket 连接。
插件会使用网络请求来：

- 登录并维持已认证的设备会话。
- 创建、列出和连接远程仓库。
- 上传加密的文件 blob 和加密的同步元数据。
- 下载加密的文件 blob 和加密的同步元数据。
- 通过 WebSocket 连接交换实时同步消息。
- 读取账户、账单、配额、存储和同步状态。

Synch 托管基础设施使用第三方服务提供商，包括用于托管、存储、网络、数据库、
队列和相关基础设施的 Cloudflare。账单由 Polar 处理。

### 发送到 Synch 的数据

仓库文件内容和文件路径元数据会在上传前于你的设备上加密。Synch 存储加密的
blob 和加密的同步元数据，其设计目标是使托管服务无法读取你的明文笔记、明文文件
路径或明文仓库密钥。

端到端加密并不会隐藏所有运行所需的元数据。Synch 可能会处理账户信息、仓库标识符
和名称、组织和成员记录、本地仓库标识符、blob 标识符、文件大小、存储使用量、
时间戳、同步游标、会话信息、IP 地址、User-Agent 字符串、托管订阅的账单标识符，
以及类似的运行元数据。

### 本地仓库访问

Synch 会读取和写入当前 Obsidian 仓库中的文件，以同步所选仓库文件。它使用
Obsidian 的插件数据 API 存储插件设置，使用 Obsidian 的 secret storage API
存储设备会话令牌，并在浏览器 IndexedDB 中存储本地同步状态。

Synch 不会有意读取或写入当前 Obsidian 仓库之外的文件。

### 付款

托管服务提供免费和付费订阅方案。当前付费托管方案为 Sync Starter，支持按月或
按年计费。支付处理和订阅管理由 Polar 负责。

### 遥测、广告和隐私

Synch Obsidian 插件不包含客户端遥测，也不会显示广告。托管服务可能会处理运行、
保护、排查问题和改进服务所需的运行日志和服务元数据。

详情请阅读托管服务的法律文档：

- [隐私政策](https://synch.run/privacy)
- [服务条款](https://synch.run/terms)

### 源代码

Synch 基于 MIT License 开源。插件、托管 API 和网站的源代码发布在本仓库中。
