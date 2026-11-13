# DSH-Next

[English](README.md) | 中文

DSH-Next 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 独立维护的社区源码仓库，并非 DeepSeek 官方发行版，与 DeepSeek 无隶属关系，也未获得其背书。

`main` 保持独立线性历史；`upstream-main` 原样保留官方 `master` 的完整历史。初始源码快照为 [source-import](https://github.com/xue-ding-e/DSH-Next/tree/source-import)，原始 [MIT 许可证](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)和作者归属均予以保留。

[下载 Windows x64 版 DSH Next](https://github.com/xue-ding-e/DSH-Next/releases)。在最新的 Next 发行版中选择 `win-x64-unsigned.exe` 安装包。推送到 `main` 会触发 Windows 发布流程，生成安装包、校验和与更新清单。

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行官方上游 Web 版

安装 `Node.js`，然后运行：

```sh
pnpm dlx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/xue-ding-e/DSH-Next.git
cd DSH-Next
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

### 安装个人扩展集合

安装 DSH Next 后，完全退出应用，包括托盘进程。在 Windows PowerShell 运行下面这条命令，安装最新发布的 Profile。以后更新插件也用同一条命令。

```powershell
$d = Join-Path ([IO.Path]::GetTempPath()) ('dsh-profile-' + [guid]::NewGuid().ToString('N') + '.ps1'); try { Invoke-WebRequest -UseBasicParsing 'https://github.com/xue-ding-e/DSH-Next-Profile/releases/latest/download/Install-Latest.ps1' -OutFile $d -ErrorAction Stop; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d } finally { Remove-Item -LiteralPath $d -ErrorAction SilentlyContinue }
```

Profile 会校验下载的归档，并使用桌面端自带的运行时安装锁定版本的插件。也可以下载并解压[最新版 Windows ZIP](https://github.com/xue-ding-e/DSH-Next-Profile/releases/latest/download/dsh-next-profile-windows.zip)，再运行 `Install.cmd`。账号、Qoder PAT 和可选的 Magpie 脱敏模型在新电脑上配置。安装器和版本锁由 [DSH-Next-Profile](https://github.com/xue-ding-e/DSH-Next-Profile) 维护，插件源码在 [DSH-Next-Plugins](https://github.com/xue-ding-e/DSH-Next-Plugins)。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
