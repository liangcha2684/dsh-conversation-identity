# 发布指南（维护者自己看）

两条发布通道，互相独立，可以只做一条：

- **GitHub** —— 源码可追溯、别人能提 issue、能挂 Release 附件
- **npm** —— 命令最短，别人直接 `dsh plugin add dsh-conversation-identity`

---

## 零、一次性准备

### 1. 配 git 身份（只需一次）

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

没配的话 `git commit` 会报 `Please tell me who you are`。**这一步必须先做**，否则提交历史里的作者是空的。

### 2. 登录 npm（只需一次）

```bash
npm adduser
```

按提示输入用户名 / 密码 / 邮箱（或 `npm login` 走浏览器）。首次发布会往邮箱发一封验证信，**必须点开确认**，否则 `publish` 会被拒。

验证登录状态：

```bash
npm whoami
```

---

## 一、建 GitHub 仓库

### 网页建（不用装东西，推荐）

1. 打开 <https://github.com/new>
2. Repository name 填 **`dsh-conversation-identity`**
3. 选 **Public**（想让别人用就必须公开）
4. **不要**勾 "Add a README file" / ".gitignore" / "license" —— 本地已经有了，勾了会冲突
5. 点 Create repository

### 本地推到 GitHub

在 `plugin/dsh-conversation-identity` 目录下：

```bash
git init -b main
git add .
git commit -m "feat: 对话身份延续插件 v0.1.0"
git remote add origin https://github.com/<你的用户名>/dsh-conversation-identity.git
git push -u origin main
```

第一次 `push` 会弹浏览器让你登录 GitHub（或用 Personal Access Token 当密码）。

### 以后改代码

```bash
git add .
git commit -m "fix: 说明改了什么"
git push
```

---

## 二、发 npm 包

### 1. 先本地检查打出来的是什么

```bash
npm pack --dry-run
```

会列出将要发布的文件。确认包含：`lib/`、`client.js`、`cordis.patch.yml`、`locale/`、`icon.svg`、`README.md`、`使用说明书.md`、`LICENSE`、`package.json`。
**不含** `test/`、`scripts/`（这些只在 GitHub 上）。

### 2. 发布

```bash
npm publish
```

`dsh-conversation-identity` 是无 scope 的公开包，默认就发公开，不需要 `--access public`。

### 3. 验证

```bash
npm view dsh-conversation-identity version
```

### 4. 以后发新版

改代码 → 升版本号（会自动打 git tag）→ 推 tag → 再发。

```bash
npm version patch -m "chore: 发布 %s"   # 0.1.0 → 0.1.1（改成 minor / major 按需）
git push --follow-tags
npm publish
```

**npm 的版本号一旦发出去就不能覆盖**，只能升号重发。「删掉再发同一个号」要等 24 小时且不推荐。

---

## 三、GitHub Release（可选）

好处：别人可以不装 npm 也能下 tgz，且有个「下载页」。

1. 本地打包：`npm pack`（生成 `dsh-conversation-identity-0.1.0.tgz`）
2. 仓库页面右侧 → **Releases** → **Draft a new release**
3. Tag 填 `v0.1.0`，Title 填 `v0.1.0`
4. 描述里写这一版改了什么
5. 把 tgz **拖进** "Attach binaries" 区域
6. Publish release

之后别人就能从 Release 页直接下载 tgz，用 `dsh plugin add <下载路径>` 安装。

> 如果装了 GitHub CLI（`gh`），上面的网页操作可以换成一条命令：
> `gh release create v0.1.0 --title v0.1.0 --notes "首个版本" dsh-conversation-identity-0.1.0.tgz`

---

## 四、别人拿到之后怎么装

| 来源 | 安装命令 |
|---|---|
| npm | `dsh plugin --profile desktop add dsh-conversation-identity` |
| GitHub Release 的 tgz | `dsh plugin --profile desktop add D:/下载/dsh-conversation-identity-0.1.0.tgz` |
| 你直接发的 tgz | 同上 |
| git 仓库直链 | `dsh plugin --profile desktop add <仓库地址>`（未实测） |

装完**完全退出 DSH 再打开**。前提：对方 DSH ≥ `0.2.1-rc.5`（`package.json` 的 `engines` 卡着）。

---

## 五、发布前自检清单

- [ ] `node --test test/core.test.js test/apply.test.js` 全绿
- [ ] `node --check lib/index.js` 与 `node --check client.js` 通过
- [ ] `package.json` 的 `version` 是新的
- [ ] `engines.dsh` 没写错
- [ ] `npm pack --dry-run` 文件列表对
- [ ] 说明书里的命令与实际一致
