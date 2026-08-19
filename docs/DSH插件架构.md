# DSH「一切皆插件」底层架构

> DeepSeek Harness（DSH）是 DeepSeek AI 开源的 agent harness，核心设计：**Everything is a Plugin**。
> 底层驱动是 **Cordis** —— 一个基于「时空可组合性（Spatiotemporal Composability）」编程范式的插件框架。
> 本文梳理这套插件化架构的核心概念与设计思想。

---

## 一、定位：DSH 是什么

```
DSH = Agent Harness（Agent 驾驭框架）

不是又一个 LLM SDK，而是：
  一个"插件宿主"——所有能力（Agent、工具、模型、UI）都以插件形式挂载
```

官网一句话：`DeepSeek Harness: Everything is a Plugin.`

底层依赖（从 DSH 仓库 vendor 目录可见）：
- `cordis` —— 插件框架核心
- `cosmokit` —— 基础工具库（Cordis 生态）

---

## 二、Cordis：底层插件框架

Cordis 是 DSH 的骨架，设计论文《A Programming Paradigm for Spatiotemporal Composability》（时空可组合性的编程范式）。

**核心思想**：程序不是"函数调用树"，而是**「插件 × 上下文 × 生命周期」的三维组合**。

```
传统程序（时间维度）：
  main → 函数A → 函数B → ... （线性调用）

Cordis 程序（时间 × 空间维度）：
  插件在"上下文"中注册服务，服务之间有依赖关系，
  插件随上下文的生命周期启停、销毁、隔离。
```

---

## 三、核心概念

### 3.1 Context（上下文 = 插件的作用域）

```typescript
// 根上下文：应用启动时创建
const root = new Context();

// 插件在 context 上挂载
root.plugin(myPlugin);

// 子上下文：继承父上下文，可隔离作用域
const child = root.isolate(['serviceA']);  // 只保留部分服务的子上下文
```

**关键**：上下文不是全局单例，而是**可嵌套、可隔离的作用域**。这实现了"空间可组合性"——不同插件可以在不同作用域生效，互不干扰。

### 3.2 Service（服务 = 插件提供的功能单元）

```typescript
// 插件通过 ctx.provide 暴露服务
ctx.provide('model', { chat: () => '...' });

// 其他插件通过 ctx.inject 声明依赖并消费
ctx.inject(['model'], (model) => {
  // 使用 model 服务
});
```

**服务是插件的"接口"**——插件不直接 import 其他插件，而是声明依赖的服务，由框架注入。

### 3.3 依赖注入（声明式依赖）

```typescript
// 插件声明自己需要哪些服务
function myAgent(ctx: Context) {
  ctx.inject(['model', 'toolkit', 'session'], (deps) => {
    const { model, toolkit, session } = deps;
    // 拿到依赖，开始干活
  });
}
```

**与 NestJS 的区别**：

| | NestJS | Cordis |
|---|--------|--------|
| 依赖声明 | 构造函数参数类型 | `ctx.inject([...])` |
| 作用域 | 模块级 | 上下文级（可嵌套隔离） |
| 生命周期 | 实例生命周期 | 上下文生命周期（可启停） |

### 3.4 生命周期（可启动、可停止、可销毁）

```typescript
ctx.on('ready', () => { /* 所有依赖就绪后 */ });
ctx.on('dispose', () => { /* 上下文销毁时清理 */ });
```

**关键**：插件不是"启动就永远活着"，而是随上下文启停。这让插件可以**热插拔**——运行时动态加载/卸载。

---

## 四、「一切皆插件」意味着什么

在 DSH 里，连这些核心概念都是插件：

```
传统框架（硬编码分层）：
  Agent 层 → 工具层 → 模型层 → UI 层（每层写死）

DSH（一切皆插件）：
  Agent 是插件
  工具是插件
  模型是插件
  UI 是插件
  记忆是插件
  MCP 客户端是插件
  ... 所有能力都是插件
```

**收益**：
1. **可扩展**：新增能力 = 写个插件挂上去，不用改核心代码
2. **可组合**：插件之间通过服务依赖组合，而不是硬编码调用
3. **可隔离**：不同场景（不同 Agent）可以加载不同插件集合
4. **可热插拔**：运行时动态加载/卸载插件

---

## 五、与你 matrix-ai-agent 的对比

这是理解 DSH 架构价值的最好参照：

| 维度 | matrix-ai-agent（你写的） | DSH（Cordis） |
|------|--------------------------|--------------|
| Agent | 硬编码 AgentType 枚举 | Agent 是插件，动态注册 |
| 工具 | 硬编码 tools 数组 | 工具是插件/服务，依赖注入 |
| 模型 | 硬编码 AGENT_MODELS 映射 | 模型是服务，可插拔 |
| 扩展 | 改代码 + 注册 | 写插件挂载 |
| 隔离 | 无（全局共享） | Context 作用域隔离 |

**你的 agent-core 已经迈出了第一步**——把 Agent 基类、工具注册器、LLM 适配器抽象成独立 npm 包。DSH 则是把这种"模块化"推进到了极致：**用插件框架统一所有扩展点**。

---

## 六、Cordis 的核心设计思想（时空可组合性）

```
时间维度（Temporal）：生命周期
  插件随上下文启停、销毁——"什么时候活着"

空间维度（Spatial）：作用域
  插件在上下文中注册，上下文可嵌套隔离——"在哪里生效"

组合（Composability）：
  插件 = 服务提供者 + 服务消费者
  通过依赖注入，插件像积木一样自由组合
```

**一句话**：Cordis 把"程序"从"调用树"重构成了"插件在时空中的组合"，这是 DSH 能支撑"一切皆插件"的底层原因。

---

## 七、面试讲点（如果你被问到 DSH 架构）

1. **DSH 是 agent harness，不是 LLM SDK** —— 定位清晰
2. **一切皆插件** —— Agent/工具/模型/UI 都是插件
3. **底层是 Cordis** —— 时空可组合性范式，核心是 Context + Service + 依赖注入 + 生命周期
4. **对比 NestJS** —— 都是依赖注入，但 Cordis 的 Context 可嵌套隔离，支持热插拔

---

## 八、参考

- DSH 仓库：`github.com/deepseek-ai/deepseek-harness`
- Cordis：`github.com/cordiverse/cordis`
- 设计论文：《A Programming Paradigm for Spatiotemporal Composability》
