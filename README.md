# AI Interviewer

视频会议风格的实时 AI 面试官：快轨流式对话 + 慢轨后台总结、VAD 打断、Trace 观测。支持 **DeepSeek** 或 **OpenAI**（见 `.env.example`）。

## 本地运行

```bash
cp .env.example .env
# 编辑 .env，至少填写 DEEPSEEK_API_KEY 或 OPENAI_API_KEY

npm install
npm run dev
```

- 前端：<http://localhost:5173>
- API：<http://127.0.0.1:8787>

语音识别依赖 Chrome/Edge 的 Web Speech（连 Google）；在 IDE 内置浏览器中可能失败，可用页面上的 **文字回答**。

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 同时启动 Vite 与 Express |
| `npm run build` | 前端生产构建 |
| `npm run eval` | 50 条探针压测（需先单独起 API） |
