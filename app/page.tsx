import Link from "next/link";
import type { Metadata } from "next";

/**
 * The landing page (S5 / #116 / RFC 0007 §4).
 *
 * What it has to do, in order: say in one sentence what the product is, give a
 * signed-out visitor somewhere to go, and state the boundary — this is a
 * nutrition assistant, not medical advice. The last one is not boilerplate: the
 * product refuses some questions by design (allergies, drug interactions,
 * unverifiable numbers), and a first-time reader who does not know that would read
 * a refusal as a bug.
 *
 * Mobile first: the primary action is inside the first screen, the layout is a
 * single column that cannot scroll sideways, and the boundary is a paragraph
 * rather than a dismissible banner — a disclaimer that can be dismissed is one
 * nobody reads.
 */
export const metadata: Metadata = {
  title: "NutriBuddy — 你的循证营养助手",
  description:
    "记录餐食、查看营养事实、给出带依据的建议。过敏与用药按硬约束处理，数字只来自可核对的食品目录。",
};

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-between gap-10 px-5 py-10">
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">
            NutriBuddy
          </h1>
          <p className="text-lg leading-relaxed text-gray-700">
            你的循证营养助手：记下吃了什么，得到能核对出处的回答。
          </p>
        </header>

        <ul className="flex flex-col gap-2 text-sm text-gray-600">
          <li>· 过敏原与用药是硬约束：命中就拒绝给建议，而不是含糊带过</li>
          <li>· 营养数字只来自本地食品目录，不靠模型记忆</li>
          <li>· 涉及权威指南的说法会给出可点开的原文出处</li>
        </ul>

        <div className="flex flex-col gap-3">
          <Link
            href="/chat"
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-3 text-base font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            开始记录
          </Link>
          <Link
            href="/profile"
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-5 py-3 text-base font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            登录 / 管理档案
          </Link>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-gray-500">
        本项目提供营养信息与记录工具，<strong>不构成医疗建议</strong>
        ，也不能替代医生或注册营养师。有疾病、正在服药或怀孕时，请先咨询专业人士。
      </p>
    </main>
  );
}
