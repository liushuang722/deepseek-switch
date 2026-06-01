# DeepSeek Switch

DeepSeek Switch 是一个运行在本机的 Codex CLI 代理工具。  
它提供兼容 OpenAI Responses API 的本地服务，并将 Codex CLI 的请求转换为 DeepSeek Chat Completions API 请求，让 Codex 可以使用 DeepSeek 模型。

## 功能特点

- 本地启动 OpenAI Responses API 兼容服务
- 支持 Codex CLI 接入 DeepSeek 模型
- 支持流式响应 SSE
- 支持 tool calls / function calls 转换
- 支持 DeepSeek reasoning / thinking 内容处理
- 提供本地网页控制台
- 可保存 DeepSeek API Key、模型名称、端口配置
- 支持自定义模型名称
- 内置 `deepseek-v4-pro`、`deepseek-v4-flash` 等模型选项
- 提供 Token、缓存命中、费用估算等本地统计

## 适合谁使用

- 想在 Codex CLI 中使用 DeepSeek 模型的用户
- 想通过本地代理兼容 OpenAI Responses API 的用户
- 想查看本地请求用量、Token 消耗和缓存命中的用户
- 不想手动修改 Codex 配置文件的用户

## 快速开始

### 1. 安装依赖

```bash
npm install
2. 启动服务

npm start
默认启动地址：


http://127.0.0.1:11435/
Responses API 地址：


http://127.0.0.1:11435/v1/responses
3. 配置 API Key
打开本地控制台：


http://127.0.0.1:11435/
在页面中填写 DeepSeek API Key，选择模型和端口，然后点击保存或自动配置 Codex。

你也可以复制 .env_example 为 .env，手动填写：


api_key=sk-your-deepseek-api-key
Windows 用户
Windows 用户也可以直接运行：


start.bat
它会自动检查依赖并启动本地服务。

常用命令

npm install
npm start
npm test
npm run test:translate
运行单个测试文件：


node --test tests/sse.test.js
node --test tests/stats.test.js
配置说明
配置优先级：

项目根目录的 config.json
环境变量 / .env
默认配置
默认配置：


{
  model: "deepseek-v4-pro",
  port: 11435,
  autoOpen: true
}
支持的环境变量：


api_key=your-deepseek-api-key
PORT=11435
MODEL=deepseek-v4-pro
Codex 配置
点击页面中的“保存并配置 Codex”后，工具会自动写入本机 Codex 配置：

~/.codex/config.toml
~/.codex/auth.json
并将 Codex 的模型供应商指向本地代理：


http://127.0.0.1:11435/v1
项目结构

.
├── index.js                 # HTTP 服务入口，本地代理主逻辑
├── lib/
│   ├── config.js             # 配置读取与保存
│   ├── log.js                # 日志输出
│   ├── recover.js            # reasoning_content 恢复逻辑
│   ├── sse.js                # SSE 流式响应转换
│   ├── stats.js              # Token 和费用统计
│   └── translate.js          # Responses API -> Chat Completions 转换
├── public/
│   ├── index.html            # 本地控制台页面
│   ├── style.css             # 页面样式
│   └── app.js                # 前端交互逻辑
├── tests/
│   ├── sse.test.js
│   └── stats.test.js
├── test_translate.js         # 协议转换测试
├── start.bat                 # Windows 启动脚本
├── package.json
└── .env_example
本地文件说明
以下文件属于本地运行状态，不建议提交到公开仓库：


.env
config.json
stats.json
node_modules/
.codex/
*.log
项目已经在 .gitignore 中忽略这些文件。

注意事项
本项目是非官方本地工具，不隶属于 OpenAI、Codex 或 DeepSeek。

控制台中的 Token 和费用统计仅供参考，实际用量和扣费请以 DeepSeek 官方平台为准。

License
ISC


