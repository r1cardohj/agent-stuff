/**
 * Miss Lee - 中英语言助手
 *
 * 用法: /misslee <句子>
 * - 输入中文 → 翻译成地道、自然的英语表达(可给出多种语体版本)
 * - 输入英文 → 用中文点评句式/语法/用词是否有问题,并给出改进建议
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const ZH_TO_EN_PROMPT = (text: string) =>
	`请把下面这段中文翻译成地道的英语表达。要求:
1. 不要逐字直译,要符合英语母语者的自然表达习惯;
2. 如果语境允许,给出 2-3 个版本(例如:正式/书面、日常口语、更简洁的说法);
3. 简要说明每个版本的适用场景和关键表达点(用中文说明)。

原文:
${text}`;

const EN_TO_ZH_PROMPT = (text: string) =>
	`请用中文分析下面这段英文,并给出建议。要求:
1. 指出句式、语法、用词、时态、搭配等方面是否有问题(没有问题也要明确说"没有问题");
2. 如果有问题,逐一解释为什么,并给出修改后的版本;
3. 如果原句本身正确,可以提供 1-2 个更地道或更自然的替代表达,并说明区别;
4. 全部用中文回复。

原句:
${text}`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("misslee", {
		description: "中文→地道英语翻译;英文→中文点评句式并给建议",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("用法: /misslee <中文或英文句子>", "warning");
				return;
			}

			// 判断是否包含中文字符
			const hasChinese = /[一-鿿]/.test(text);
			const prompt = hasChinese ? ZH_TO_EN_PROMPT(text) : EN_TO_ZH_PROMPT(text);

			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				// Agent 正在处理,排队为 follow-up
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("已加入队列,等待当前任务完成", "info");
			}
		},
	});
}
