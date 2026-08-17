import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnNodeScript, type RuntimeInfo } from './node-runtime'

/** 官方 DSH 的 npm 包名 */
const PKG = '@deepseek-ai/dsh'

/** 一次安装的结果 */
export interface DshInstall {
  /** 实际安装版本（如 0.1.0-rc.6） */
  version: string
  /** DSH 入口脚本（lib/bin.js）绝对路径，供进程托管模块去 spawn */
  binPath: string
  /** 该版本安装根目录（node_modules 所在） */
  installDir: string
}

/** 包管理器命令的输出 */
interface PmResult {
  stdout: string
  stderr: string
}

/**
 * version-manager.ts —— DSH 版本管理
 *
 * 【思路】
 * 官方 DSH 是 npm 包 @deepseek-ai/dsh。我们把它按版本号安装到
 * 应用数据目录的 versions/<版本>/ 下，相当于给每个版本一个独立沙盒：
 *   - 想升级？把版本号换成新的，装到另一个目录即可，互不干扰；
 *   - 想回退？直接指向旧版本目录即可。
 * 这样官方页面怎么升级，壳的启动代码都只要改一个版本字符串。
 *
 * 【npm install --prefix 的含义】
 * 默认 npm install 会把包装到「当前目录的 node_modules」。
 * 加 --prefix <目录> 后，它把 <目录> 当成项目根，依赖装到
 * <目录>/node_modules 下，这样我们就能把不同版本分别放到不同目录。
 *
 * 【bin 入口怎么找】
 * npm 包的 package.json 里有 bin 字段，声明「这个包的命令对应哪个脚本」。
 * @deepseek-ai/dsh 的 bin 是 { dsh: "lib/bin.js" }，
 * 我们读它拿到脚本相对路径，拼成绝对路径交给 Node 执行。
 */
/** 支持的包管理器 */
export type PackageManager = 'pnpm' | 'npm'

export class VersionManager {
  constructor(
    private readonly versionsRoot: string,
    private readonly pm: PackageManager = 'pnpm',
    private readonly pmPath?: string,
    private readonly nodeRuntime?: RuntimeInfo,
    private readonly pnpmScript?: string,
  ) {}

  /**
   * 确保 spec 对应的版本已安装（已装则直接复用），返回安装信息。
   * spec 为 'latest' 时先向 npm 查询最新版本号，其余情况直接当版本号用。
   */
  async ensure(spec: string, onLog?: (line: string) => void): Promise<DshInstall> {
    // 先确保安装根目录存在：后面 spawn 子进程会把它当 cwd，
    // Windows 下 cwd 指向不存在的目录会导致 spawn 报 ENOENT
    await fsp.mkdir(this.versionsRoot, { recursive: true })

    // 1. 把 spec 解析成确定版本号（latest → 真实版本）
    const version = await this.resolveVersion(spec, onLog)
    // 2. 每个版本一个目录，互不干扰
    const installDir = path.join(this.versionsRoot, version)
    const pkgDir = path.join(installDir, 'node_modules', PKG)

    // 3. 已装过就直接复用，不重复下载
    const existingBin = await this.readBinPath(pkgDir)
    if (existingBin !== undefined) {
      return { version, binPath: existingBin, installDir }
    }

    // 4. 未装过：用 npm 安装到专属目录
    await fsp.mkdir(installDir, { recursive: true })
    onLog?.(`正在用 ${this.pm} 安装 ${PKG}@${version} ...`)
    await this.runPm(this.buildInstallArgs(installDir, version), installDir, onLog)

    // 5. 装完再读一次 bin 入口
    const binPath = await this.readBinPath(pkgDir)
    if (binPath === undefined) {
      throw new Error(`安装完成但未在 ${pkgDir} 找到 ${PKG} 的 bin 入口`)
    }
    return { version, binPath, installDir }
  }

  /**
   * 读取已安装包的 bin 入口绝对路径；不存在返回 undefined。
   * 从包的 package.json 的 bin 字段解析。
   */
  private async readBinPath(pkgDir: string): Promise<string | undefined> {
    try {
      const pkgJson = JSON.parse(await fsp.readFile(path.join(pkgDir, 'package.json'), 'utf8'))
      // bin 可能是字符串（单命令）或对象（多命令），这里兼容两种
      const bin = pkgJson.bin as string | { dsh?: string } | undefined
      const rel = typeof bin === 'string' ? bin : bin?.dsh
      if (rel === undefined) return undefined
      const binPath = path.join(pkgDir, path.normalize(rel))
      // 确认文件真实存在，避免拿到一个声明了但缺文件的包
      await fsp.access(binPath, fs.constants.F_OK)
      return binPath
    } catch {
      return undefined
    }
  }

  /** 把 'latest' 解析成具体版本号（调用 npm view） */
  private async resolveVersion(spec: string, onLog?: (line: string) => void): Promise<string> {
    if (spec !== 'latest') return spec
    onLog?.(`正在查询 ${PKG} 最新版本 ...`)
    // npm view <包> version 会打印最新版本号，例如输出一行 "0.1.0-rc.6"
    const res = await this.runPm(['view', `${PKG}@latest`, 'version'], undefined, onLog)
    const version = res.stdout.trim().split('\n')[0]?.trim() ?? ''
    // 简单校验版本号格式，防止拿到错误输出
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(`无法解析最新版本号，npm view 输出：${res.stdout.trim().slice(0, 200)}`)
    }
    return version
  }

  /** 按包管理器拼出「安装到指定目录」的参数 */
  private buildInstallArgs(installDir: string, version: string): string[] {
    if (this.pm === 'pnpm') {
      // pnpm 用 --dir 指定目标目录；--dangerously-allow-all-builds 允许官方包
      // 的原生依赖跑构建脚本（pnpm 默认拦截依赖构建，原生模块可能因此装不上）
      return ['--dir', installDir, 'add', `${PKG}@${version}`, '--dangerously-allow-all-builds', '--reporter', 'append-only']
    }
    return [
      'install',
      '--prefix', installDir, // 把 installDir 当项目根
      `${PKG}@${version}`, // 固定要装的包和版本
      '--no-audit', // 跳过安全审计，省时间
      '--no-fund', // 不打印捐赠提示
      '--no-save', // 不写 package.json（我们不需要 lock 文件）
      '--loglevel', 'warn',
    ]
  }

  /** 执行一条包管理器命令并收集 stdout/stderr */
  private runPm(args: string[], cwd: string | undefined, onLog?: (line: string) => void): Promise<PmResult> {
    // 内置 pnpm：用 Electron 内置 Node 执行打包进来的 pnpm.cjs，
    // 不依赖系统是否安装 pnpm（打包后终端用户也无需安装）
    if (this.pm === 'pnpm' && this.nodeRuntime !== undefined && this.pnpmScript !== undefined) {
      const child = spawnNodeScript(this.nodeRuntime, this.pnpmScript, { args, cwd: cwd ?? this.versionsRoot })
      return this.collect(child, 'pnpm', onLog)
    }
    // 兜底：调用系统的包管理器（npm 模式，或用户指定的 pnpm 路径）
    const cmd = this.pmPath ?? this.pm
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return this.collect(child, cmd, onLog)
  }

  /** 收集子进程输出直到退出 */
  private collect(child: ChildProcess, label: string, onLog?: (line: string) => void): Promise<PmResult> {
    return new Promise<PmResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString()
        stdout += s
        onLog?.(s)
      })
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString()
        stderr += s
        onLog?.(s)
      })
      child.on('error', (err) =>
        reject(new Error(`无法启动包管理器（${label}）：${err.message}。npm 兜底模式请确认已安装，或通过 DSH_DESKTOP_PM_PATH 指定路径`)),
      )
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`包管理器执行失败（退出码 ${code}）：${stderr.trim().slice(-800) || stdout.trim().slice(-800)}`))
      })
    })
  }
}
