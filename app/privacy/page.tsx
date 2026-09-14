import Link from "next/link";
import type { Metadata } from "next";

/**
 * The user-facing privacy statement (S5 / #115).
 *
 * Short by design, and it says the two things a reader cannot infer and would
 * otherwise assume the friendly way: traces are kept 90 days and then deleted, and
 * deleting an account does **not** reach the model provider's logs — the request
 * content leaves this server when an answer is generated.
 *
 * The operator-facing version, with the provider terms quoted and the storage
 * layout, is `docs/privacy.md`; this page is the disclosure the platform terms
 * require be made to end users.
 */
export const metadata: Metadata = {
  title: "隐私与数据 — NutriBuddy",
  description:
    "收集什么、留多久、谁能看到、怎么删除，以及模型供应商一侧会发生什么。",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-8 px-5 py-10 text-sm leading-relaxed text-gray-700">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-xs text-blue-700 underline">
          ← 返回首页
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">隐私与数据</h1>
        <p className="text-gray-500">最后核对：2026-09-14</p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-gray-900">收集什么</h2>
        <p>
          邮箱（登录用）、你的档案（过敏原、用药、营养目标、身高体重）、你确认过的餐食记录，
          以及每一轮的运行轨迹（你的问题、模型用量、工具调用、检查结论）。
        </p>
        <p>不收集照片、位置、通讯录，也没有第三方分析 SDK。</p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-gray-900">留多久</h2>
        <ul className="flex flex-col gap-1">
          <li>· 运行轨迹：<strong>保留 90 天</strong>，之后按月滚动删除</li>
          <li>· 档案与餐食记录：保留到你删除账号为止（它们就是产品功能本身）</li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-gray-900">谁能看到</h2>
        <p>
          浏览器只能读到自己的数据（数据库行级策略强制）；服务端持有更高权限的密钥，用于写入轨迹、
          读取公共语料和删除账号。运维者技术上能看到全部数据 —— 这是一个给少量白名单用户使用的部署，
          与其含糊，不如写明。数据没有数据库以外的副本。
        </p>
      </section>

      <section className="flex flex-col gap-2" data-provider-disclosure>
        <h2 className="text-base font-semibold text-gray-900">
          模型供应商一侧（请注意）
        </h2>
        <p>
          生成回答时，<strong>本轮上下文</strong>（你的问题、必要的档案约束、检索到的权威片段）
          会发送给模型 API。也就是说<strong>这些内容会离开本项目的服务器</strong>，
          而<strong>删除本项目的账号不会回溯清除供应商侧已经收到的内容</strong>。
        </p>
        <p>
          供应商公开条款：
          <a
            className="text-blue-700 underline"
            href="https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html"
            target="_blank"
            rel="noreferrer"
          >
            DeepSeek Open Platform Terms of Service
          </a>{" "}
          与{" "}
          <a
            className="text-blue-700 underline"
            href="https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html"
            target="_blank"
            rel="noreferrer"
          >
            DeepSeek Privacy Policy
          </a>
          。这些条款<strong>没有对 API 侧的保留期限给出承诺，也没有声明 API 输入不用于训练</strong>
          ，所以我们也<strong>不做这方面的承诺</strong>
          ：本项目按"发出去的上下文已离开本项目控制"处理。
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-gray-900">删除账号</h2>
        <p>
          账号页底部有删除入口，需要手打 <code>DELETE</code> 确认，且<strong>不可撤销</strong>。
          删除会一并移除你的档案、餐食记录、提案和全部运行轨迹。
        </p>
        <p>
          食品目录与依据语料是公共数据，不属于你的账号，因此不受影响；模型供应商侧已经收到的内容也不受影响
          （见上一节）。
        </p>
      </section>

      <section
        className="flex flex-col gap-2 rounded-md bg-gray-50 p-4"
        data-non-medical
      >
        <h2 className="text-base font-semibold text-gray-900">非医疗建议</h2>
        <p>
          本工具提供营养信息与记录功能，<strong>不构成医疗建议</strong>，不能替代医生或注册营养师。
          回答由 AI 生成、可能出错；涉及医疗、法律、财务的问题不构成任何建议。
          有疾病、正在服药或怀孕时，请先咨询专业人士。
        </p>
      </section>
    </main>
  );
}
