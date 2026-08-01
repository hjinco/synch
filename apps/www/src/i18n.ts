export const defaultLocale = "en";
export const locales = ["en", "ko", "ja", "zh-cn", "zh-tw"] as const;

export type Locale = (typeof locales)[number];

export const localeLanguageTags: Record<Locale, string> = {
	en: "en",
	ko: "ko",
	ja: "ja",
	"zh-cn": "zh-CN",
	"zh-tw": "zh-TW",
};

export const openGraphLocales: Record<Locale, string> = {
	en: "en_US",
	ko: "ko_KR",
	ja: "ja_JP",
	"zh-cn": "zh_CN",
	"zh-tw": "zh_TW",
};

export function getLocale(locale?: string): Locale {
	return locales.includes(locale as Locale) ? (locale as Locale) : defaultLocale;
}

export function localizedPath(locale: Locale, path = "/") {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	const normalizedPagePath = normalizedPath.endsWith("/") ? normalizedPath : `${normalizedPath}/`;

	if (locale === defaultLocale) {
		return normalizedPagePath;
	}

	if (normalizedPagePath === "/") {
		return `/${locale}/`;
	}

	return `/${locale}${normalizedPagePath}`;
}

export function unlocalizedPath(pathname: string) {
	for (const locale of locales) {
		if (locale === defaultLocale) {
			continue;
		}

		const prefix = `/${locale}`;
		if (pathname === prefix || pathname === `${prefix}/`) {
			return "/";
		}

		if (pathname.startsWith(`${prefix}/`)) {
			return pathname.slice(prefix.length);
		}
	}

	return pathname || "/";
}

export function blogSlug(id: string, locale: Locale) {
	return id
		.replace(new RegExp(`^${locale}/`), "")
		.replace(new RegExp(`/${locale}$`), "")
		.replace(/\/index$/, "");
}

export function isLocaleEntry(id: string, locale: Locale) {
	return id.startsWith(`${locale}/`) || id.endsWith(`/${locale}`);
}

export const ui = {
	en: {
		meta: {
			defaultTitle: "Synch - Open-source E2EE sync for Obsidian",
			defaultDescription:
				"An open-source alternative to Obsidian Sync. Your notes are encrypted locally before leaving your device, ensuring complete privacy and control over your data.",
			pricingTitle: "Pricing - Synch",
			pricingDescription: "Compare Synch plans and storage limits for end-to-end encrypted Obsidian vault sync.",
			blogTitle: "Blog - Synch",
			blogDescription: "Articles about end-to-end encrypted Obsidian sync, privacy, and Synch development.",
			billingTitle: "Billing - Synch",
			billingDescription: "Manage your Synch subscription and billing settings.",
			billingSuccessTitle: "Confirming subscription - Synch",
			billingSuccessDescription: "Confirming your Synch subscription and applying it to your account.",
			notFoundTitle: "Page not found - Synch",
			notFoundDescription: "The page you requested could not be found.",
		},
		nav: {
			pricing: "Pricing",
			github: "GitHub",
			signIn: "Sign In",
			signUp: "Sign Up",
			vaults: "Vaults",
			blog: "Blog",
			terms: "Terms",
			privacy: "Privacy",
		},
		home: {
			heroTitle: ["End-to-end encrypted sync", "for Obsidian."],
			featuredTitle: "Learn more",
			featuredPosts: [
				{
					title: "How does Synch's end-to-end encryption work?",
					body: "A plain-English walkthrough of how Synch encrypts vault data, protects the vault key, and unlocks encrypted data on another device.",
					href: "/blog/encryption-and-decryption"
				}
			],
			heroBody:
				"An open-source alternative to Obsidian Sync. Your notes are encrypted locally before leaving your device, ensuring complete privacy and control over your data.",
			getStarted: "Get Started",
			viewSource: "View Source",
			features: [
				{
					title: "Sync in 3 seconds",
					body: "Synch checks for changes frequently so edits can move between devices in just a few seconds.",
				},
				{
					title: "Version history",
					body: "Recover from accidental edits with encrypted history for synced files, available within your plan's retention window.",
				},
				{
					title: "Deleted file recovery",
					body: "Bring back deleted notes and attachments while they are still kept in version history.",
				},
				{
					title: "Automatic conflict merges",
					body: "When the same note changes on multiple devices, Synch uses a 3-way merge to combine compatible edits automatically.",
				},
			],
			installTitle: "How to Install",
			installIntro: "Install Synchrun from Obsidian's Community Plugins directory.",
			installSteps: [
				["Open Obsidian Settings and go to", "Community plugins", "."],
				["Turn off Restricted mode, then select", "Browse", "."],
				["Search for", "Synchrun", ", select it, and choose Install."],
				["Enable", "Synchrun", " after installation finishes."],
			],
			selfHosting: {
				title: "Use your own Synch server",
				body: "Create a Synch server on a free Cloudflare account and paste its address into the Obsidian plugin. The guide walks through the setup step by step.",
				link: "Read the self-hosting guide",
			},
		},
		pricing: {
			heading: "Simple, transparent pricing.",
			subheading: "Start syncing your vaults for free.",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			plusPlan: "Sync Plus",
			forever: "/ forever",
			month: "/ month",
			year: "/ year",
			monthly: "Monthly",
			annual: "Annual",
			comingSoon: "Coming Soon",
			features: {
				oneVault: "1 synced vault",
				freeStorage: "50 MB storage",
				starterStorage: "1 GB storage",
				freeFileSize: "3 MB max file size",
				starterFileSize: "5 MB max file size",
				freeHistory: "1 day version history",
				starterHistory: "1 month version history",
				plusOrganizationMembers: "Up to 3 members",
				plusVaults: "5 synced vaults",
				plusStorage: "50 GB storage",
				plusStorageTooltip: "10 GB per vault",
				plusFileSize: "200 MB max file size",
				plusHistory: "1 year version history",
			},
		},
		blog: {
			heading: "Blog",
			empty: "No blog posts have been added yet.",
			dateLocale: "en",
			ctaTitle: "Ready to sync your Obsidian vault?",
			ctaBody:
				"Start for free with end-to-end encrypted sync, or compare plans if you need more storage and longer version history.",
			ctaPrimary: "Get Started",
			ctaSecondary: "View pricing",
		},
		billing: {
			heading: "Confirming subscription",
			message: "Your subscription is being applied. This usually takes a few seconds.",
			continue: "Continue to vaults",
			fallback: "Still waiting for payment confirmation. You can continue and refresh later.",
		},
		notFound: {
			eyebrow: "404",
			heading: "Page not found",
			message: "This page may have moved, or the link may no longer be valid.",
			home: "Go home",
			pricing: "View pricing",
		},
		billingSettings: {
			eyebrow: "Billing",
			heading: "Manage subscription",
			subheading: "View your current plan and open the billing portal to change or cancel your subscription.",
			loading: "Loading billing status...",
			currentPlan: "Current plan",
			renewal: "Renewal",
			endsOn: "Ends on",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			monthly: "Monthly",
			annual: "Annual",
			freeInterval: "Free",
			canceling: "Canceling",
			canceled: "Canceled",
			noRenewalDate: "No renewal scheduled",
			activeMessage: "Your subscription is active. Open the billing portal to change your plan, cancel, or update payment details.",
			cancelingMessage: "Your subscription is set to cancel at the end of the current billing period.",
			canceledMessage: "Your subscription has been canceled. Your current plan is free.",
			freeMessage: "You are currently on the free plan. Upgrade when you need more storage.",
			manage: "Manage subscription",
			upgrade: "View plans",
			authRequired: "Sign in to view and manage your subscription.",
			signIn: "Sign in",
			error: "Billing information could not be loaded. Try again in a moment.",
			retry: "Retry",
		},
	},
	ko: {
		meta: {
			defaultTitle: "Synch - Obsidian용 오픈소스 종단 간 암호화 동기화",
			defaultDescription:
				"Obsidian Sync를 대체할 수 있는 오픈소스 동기화 서비스입니다. 노트는 기기 안에서 먼저 암호화된 뒤 전송되므로, 내 데이터는 내가 안전하게 관리할 수 있습니다.",
			pricingTitle: "요금제 - Synch",
			pricingDescription: "종단 간 암호화 Obsidian vault 동기화를 위한 Synch 요금제와 저장 용량을 비교하세요.",
			blogTitle: "블로그 - Synch",
			blogDescription: "종단 간 암호화 Obsidian 동기화, 개인정보 보호, Synch 개발에 관한 글을 읽어보세요.",
			billingTitle: "구독 관리 - Synch",
			billingDescription: "Synch 구독과 결제 설정을 관리하세요.",
			billingSuccessTitle: "구독 확인 중 - Synch",
			billingSuccessDescription: "Synch 구독을 확인하고 계정에 적용하는 중입니다.",
			notFoundTitle: "페이지를 찾을 수 없음 - Synch",
			notFoundDescription: "요청한 페이지를 찾을 수 없습니다.",
		},
		nav: {
			pricing: "요금제",
			github: "GitHub",
			signIn: "로그인",
			signUp: "가입하기",
			vaults: "Vaults",
			blog: "블로그",
			terms: "이용약관",
			privacy: "개인정보 처리방침",
		},
		home: {
			heroTitle: ["Obsidian을 위한", "종단 간 암호화 동기화."],
			featuredTitle: "더 알아보기",
			featuredPosts: [
				{
					title: "Synch의 종단 간 암호화는 어떻게 작동할까요?",
					body: "Synch가 데이터를 암호화하고 키를 보호하며 다른 기기에서 안전하게 데이터를 여는 방식을 알기 쉽게 설명합니다.",
					href: "/blog/encryption-and-decryption"
				}
			],
			heroBody:
				"Obsidian Sync를 대체할 수 있는 오픈소스 동기화 서비스입니다. 노트는 기기에서 먼저 암호화된 뒤 전송되므로 데이터를 더 안전하게 관리할 수 있습니다.",
			getStarted: "시작하기",
			viewSource: "소스 보기",
			features: [
				{
					title: "3초 안에 동기화",
					body: "Synch는 변경 사항을 자주 확인해 편집 내용이 몇 초 안에 다른 기기로 이동할 수 있게 합니다.",
				},
				{
					title: "버전 히스토리",
					body: "실수로 노트를 바꿔도 플랜의 보관 기간 안에서 동기화된 파일의 암호화된 기록을 되돌릴 수 있습니다.",
				},
				{
					title: "삭제된 파일 복구",
					body: "삭제한 노트와 첨부 파일도 버전 히스토리에 남아 있는 동안 다시 가져올 수 있습니다.",
				},
				{
					title: "충돌 자동 병합",
					body: "여러 기기에서 같은 노트가 바뀌면 Synch가 3-way merge로 호환되는 편집 내용을 자동 병합합니다.",
				},
			],
			installTitle: "설치 방법",
			installIntro: "Obsidian Community Plugins 디렉터리에서 Synchrun을 설치하세요.",
			installSteps: [
				["Obsidian 설정을 열고", "Community plugins", "로 이동합니다."],
				["제한 모드를 끈 뒤", "Browse", "를 선택합니다."],
				["", "Synchrun", "을 검색하고 선택한 뒤 설치합니다."],
				["설치가 끝나면", "Synchrun", "을 활성화합니다."],
			],
			selfHosting: {
				title: "내 Synch 서버 사용하기",
				body: "Cloudflare 무료 계정에 Synch 서버를 만들고 그 주소를 Obsidian 플러그인에 넣어 사용할 수 있습니다. 가이드에서 설정 과정을 차근차근 안내합니다.",
				link: "셀프 호스팅 가이드 보기",
			},
		},
		pricing: {
			heading: "간단하고 투명한 요금제.",
			subheading: "무료로 vault 동기화를 시작하세요.",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			plusPlan: "Sync Plus",
			forever: "/ 평생 무료",
			month: "/ 월",
			year: "/ 년",
			monthly: "월간",
			annual: "연간",
			comingSoon: "준비 중",
			features: {
				oneVault: "vault 1개 동기화",
				freeStorage: "저장 공간 50 MB",
				starterStorage: "저장 공간 1 GB",
				freeFileSize: "파일당 최대 3 MB",
				starterFileSize: "파일당 최대 5 MB",
				freeHistory: "버전 히스토리 1일",
				starterHistory: "버전 히스토리 1개월",
				plusOrganizationMembers: "팀원 최대 3명",
				plusVaults: "vault 5개 동기화",
				plusStorage: "저장 공간 50 GB",
				plusStorageTooltip: "vault당 10 GB",
				plusFileSize: "파일당 최대 200 MB",
				plusHistory: "버전 히스토리 1년",
			},
		},
		blog: {
			heading: "블로그",
			empty: "아직 블로그 글이 없습니다.",
			dateLocale: "ko-KR",
			ctaTitle: "Obsidian vault를 동기화해볼까요?",
			ctaBody:
				"종단 간 암호화 동기화를 무료로 시작해보거나 더 많은 저장 공간과 긴 버전 히스토리가 필요하면 요금제를 비교해보세요.",
			ctaPrimary: "시작하기",
			ctaSecondary: "요금제 보기",
		},
		billing: {
			heading: "구독 확인 중",
			message: "구독 정보를 적용하고 있습니다. 보통 몇 초 안에 완료됩니다.",
			continue: "Vaults로 이동",
			fallback: "아직 결제 확인이 끝나지 않았습니다. 먼저 이동한 뒤 나중에 새로고침해도 됩니다.",
		},
		notFound: {
			eyebrow: "404",
			heading: "페이지를 찾을 수 없습니다",
			message: "페이지가 이동되었거나 더 이상 유효하지 않은 링크일 수 있습니다.",
			home: "홈으로 이동",
			pricing: "요금제 보기",
		},
		billingSettings: {
			eyebrow: "구독",
			heading: "구독 관리",
			subheading: "현재 요금제를 확인하고 결제 포털에서 구독을 변경하거나 취소할 수 있습니다.",
			loading: "구독 상태를 불러오는 중...",
			currentPlan: "현재 요금제",
			renewal: "갱신",
			endsOn: "종료일",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			monthly: "월간",
			annual: "연간",
			freeInterval: "무료",
			canceling: "취소 예정",
			canceled: "취소됨",
			noRenewalDate: "예정된 갱신 없음",
			activeMessage: "구독이 활성화되어 있습니다. 결제 포털에서 요금제 변경, 구독 취소, 결제수단 변경을 할 수 있습니다.",
			cancelingMessage: "현재 결제 기간이 끝나면 구독이 취소될 예정입니다.",
			canceledMessage: "구독이 취소되었습니다. 현재 요금제는 무료입니다.",
			freeMessage: "현재 무료 요금제를 사용 중입니다. 더 많은 저장 공간이 필요하면 업그레이드하세요.",
			manage: "구독 관리",
			upgrade: "요금제 보기",
			authRequired: "구독을 확인하고 관리하려면 로그인하세요.",
			signIn: "로그인",
			error: "구독 정보를 불러오지 못했습니다. 잠시 후 다시 시도하세요.",
			retry: "다시 시도",
		},
	},
	ja: {
		meta: {
			defaultTitle: "Synch - Obsidian向けオープンソースE2EE同期",
			defaultDescription:
				"Obsidian Syncのオープンソース代替です。ノートはデバイス上で暗号化されてから送信されるため、データのプライバシーと管理権を保てます。",
			pricingTitle: "料金 - Synch",
			pricingDescription: "エンドツーエンド暗号化されたObsidian vault同期向けのSynchプランと容量を比較できます。",
			blogTitle: "ブログ - Synch",
			blogDescription: "エンドツーエンド暗号化されたObsidian同期、プライバシー、Synch開発に関する記事です。",
			billingTitle: "請求 - Synch",
			billingDescription: "Synchのサブスクリプションと請求設定を管理します。",
			billingSuccessTitle: "サブスクリプション確認中 - Synch",
			billingSuccessDescription: "Synchのサブスクリプションを確認し、アカウントへ適用しています。",
			notFoundTitle: "ページが見つかりません - Synch",
			notFoundDescription: "リクエストされたページは見つかりませんでした。",
		},
		nav: {
			pricing: "料金",
			github: "GitHub",
			signIn: "サインイン",
			signUp: "登録",
			vaults: "Vaults",
			blog: "ブログ",
			terms: "利用規約",
			privacy: "プライバシー",
		},
		home: {
			heroTitle: ["Obsidianのための", "エンドツーエンド暗号化同期。"],
			featuredTitle: "詳しく見る",
			featuredPosts: [
				{
					title: "Synchのエンドツーエンド暗号化はどのように動きますか?",
					body: "Synchがvaultデータを暗号化し、vault keyを保護し、別の端末で安全にデータを開く仕組みを平易に説明します。",
					href: "/blog/encryption-and-decryption"
				}
			],
			heroBody:
				"Obsidian Syncのオープンソース代替です。ノートはデバイス上で暗号化されてから送信されるため、データのプライバシーと管理権を保てます。",
			getStarted: "はじめる",
			viewSource: "ソースを見る",
			features: [
				{
					title: "3秒で同期",
					body: "Synchは変更をこまめに確認し、編集内容を数秒で別の端末へ届けられるようにします。",
				},
				{
					title: "バージョン履歴",
					body: "誤って編集しても、プランの保持期間内なら同期済みファイルの暗号化された履歴から戻せます。",
				},
				{
					title: "削除ファイルの復元",
					body: "削除したノートや添付ファイルも、バージョン履歴に残っている間は取り戻せます。",
				},
				{
					title: "競合の自動マージ",
					body: "複数の端末で同じノートが変更された場合、Synchは3-way mergeで互換性のある編集を自動的に統合します。",
				},
			],
			installTitle: "インストール方法",
			installIntro: "Obsidian の Community Plugins ディレクトリから Synchrun をインストールしてください。",
			installSteps: [
				["Obsidian設定を開き", "Community plugins", "へ移動します。"],
				["制限モードをオフにして", "Browse", "を選択します。"],
				["", "Synchrun", "を検索し、選択してインストールします。"],
				["インストールが完了したら", "Synchrun", "を有効化します。"],
			],
			selfHosting: {
				title: "自分の Synch サーバーを使う",
				body: "Cloudflare の無料アカウントに Synch サーバーを作成し、そのアドレスを Obsidian プラグインに入力できます。",
				link: "セルフホストガイドを読む",
			},
		},
		pricing: {
			heading: "シンプルで透明な料金。",
			subheading: "無料でvault同期を始められます。",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			plusPlan: "Sync Plus",
			forever: "/ 永久無料",
			month: "/ 月",
			year: "/ 年",
			monthly: "月額",
			annual: "年額",
			comingSoon: "近日公開",
			features: {
				oneVault: "同期vault 1個",
				freeStorage: "50 MBストレージ",
				starterStorage: "1 GBストレージ",
				freeFileSize: "最大ファイルサイズ3 MB",
				starterFileSize: "最大ファイルサイズ5 MB",
				freeHistory: "1日分のバージョン履歴",
				starterHistory: "1か月分のバージョン履歴",
				plusOrganizationMembers: "メンバー最大3人",
				plusVaults: "同期vault 5個",
				plusStorage: "50 GBストレージ",
				plusStorageTooltip: "vaultあたり10 GB",
				plusFileSize: "最大ファイルサイズ200 MB",
				plusHistory: "1年分のバージョン履歴",
			},
		},
		blog: {
			heading: "ブログ",
			empty: "ブログ記事はまだありません。",
			dateLocale: "ja-JP",
			ctaTitle: "Obsidian vaultを同期しますか?",
			ctaBody:
				"エンドツーエンド暗号化同期を無料で始めるか、より多いストレージや長いバージョン履歴が必要な場合はプランを比較できます。",
			ctaPrimary: "はじめる",
			ctaSecondary: "料金を見る",
		},
		billing: {
			heading: "サブスクリプション確認中",
			message: "サブスクリプションを適用しています。通常は数秒で完了します。",
			continue: "Vaultsへ進む",
			fallback: "支払い確認がまだ完了していません。先に進み、あとで更新できます。",
		},
		notFound: {
			eyebrow: "404",
			heading: "ページが見つかりません",
			message: "ページが移動したか、リンクが無効になっている可能性があります。",
			home: "ホームへ戻る",
			pricing: "料金を見る",
		},
		billingSettings: {
			eyebrow: "請求",
			heading: "サブスクリプション管理",
			subheading: "現在のプランを確認し、請求ポータルでプラン変更や解約ができます。",
			loading: "請求状態を読み込み中...",
			currentPlan: "現在のプラン",
			renewal: "更新",
			endsOn: "終了日",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			monthly: "月額",
			annual: "年額",
			freeInterval: "無料",
			canceling: "解約予定",
			canceled: "解約済み",
			noRenewalDate: "更新予定なし",
			activeMessage: "サブスクリプションは有効です。請求ポータルでプラン変更、解約、支払い方法の更新ができます。",
			cancelingMessage: "現在の請求期間の終了時にサブスクリプションが解約されます。",
			canceledMessage: "サブスクリプションは解約されています。現在のプランは無料です。",
			freeMessage: "現在は無料プランです。容量が必要になったらアップグレードできます。",
			manage: "サブスクリプション管理",
			upgrade: "プランを見る",
			authRequired: "サブスクリプションを表示・管理するにはサインインしてください。",
			signIn: "サインイン",
			error: "請求情報を読み込めませんでした。しばらくしてから再試行してください。",
			retry: "再試行",
		},
	},
	"zh-cn": {
		meta: {
			defaultTitle: "Synch - 面向 Obsidian 的开源端到端加密同步",
			defaultDescription:
				"Obsidian Sync 的开源替代方案。你的笔记会先在设备上加密再离开设备，确保隐私和数据控制权。",
			pricingTitle: "价格 - Synch",
			pricingDescription: "比较 Synch 面向端到端加密 Obsidian vault 同步的方案和存储限制。",
			blogTitle: "博客 - Synch",
			blogDescription: "关于端到端加密 Obsidian 同步、隐私和 Synch 开发的文章。",
			billingTitle: "账单 - Synch",
			billingDescription: "管理你的 Synch 订阅和账单设置。",
			billingSuccessTitle: "正在确认订阅 - Synch",
			billingSuccessDescription: "正在确认你的 Synch 订阅并应用到账户。",
			notFoundTitle: "页面未找到 - Synch",
			notFoundDescription: "无法找到你请求的页面。",
		},
		nav: {
			pricing: "价格",
			github: "GitHub",
			signIn: "登录",
			signUp: "注册",
			vaults: "Vaults",
			blog: "博客",
			terms: "条款",
			privacy: "隐私",
		},
		home: {
			heroTitle: ["面向 Obsidian 的", "端到端加密同步。"],
			featuredTitle: "了解更多",
			featuredPosts: [
				{
					title: "Synch 的端到端加密是如何工作的？",
					body: "用通俗方式说明 Synch 如何加密 vault 数据、保护 vault key，并在另一台设备上安全打开数据。",
					href: "/blog/encryption-and-decryption"
				}
			],
			heroBody:
				"Obsidian Sync 的开源替代方案。你的笔记会先在设备上加密再离开设备，确保隐私和数据控制权。",
			getStarted: "开始使用",
			viewSource: "查看源码",
			features: [
				{
					title: "3 秒同步",
					body: "Synch 会频繁检查更改，让编辑内容可在几秒内同步到其他设备。",
				},
				{
					title: "版本历史",
					body: "误改内容后，可在方案保留期内从同步文件的加密历史中恢复。",
				},
				{
					title: "恢复已删除文件",
					body: "已删除的笔记和附件只要仍保留在版本历史中，就可以找回。",
				},
				{
					title: "自动合并冲突",
					body: "当同一篇笔记在多台设备上被修改时，Synch 会使用 3-way merge 自动合并兼容的编辑。",
				},
			],
			installTitle: "如何安装",
			installIntro: "请从 Obsidian 的 Community Plugins 目录安装 Synchrun。",
			installSteps: [
				["打开 Obsidian 设置并进入", "Community plugins", "。"],
				["关闭受限模式，然后选择", "Browse", "。"],
				["搜索", "Synchrun", "，选择它并安装。"],
				["安装完成后，启用", "Synchrun", "。"],
			],
			selfHosting: {
				title: "使用自己的 Synch 服务器",
				body: "你可以在 Cloudflare 免费账号中创建 Synch 服务器，并把它的地址填入 Obsidian 插件。",
				link: "阅读自托管指南",
			},
		},
		pricing: {
			heading: "简单透明的价格。",
			subheading: "免费开始同步你的 vault。",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			plusPlan: "Sync Plus",
			forever: "/ 永久",
			month: "/ 月",
			year: "/ 年",
			monthly: "月付",
			annual: "年付",
			comingSoon: "即将推出",
			features: {
				oneVault: "1 个同步 vault",
				freeStorage: "50 MB 存储",
				starterStorage: "1 GB 存储",
				freeFileSize: "最大文件 3 MB",
				starterFileSize: "最大文件 5 MB",
				freeHistory: "1 天版本历史",
				starterHistory: "1 个月版本历史",
				plusOrganizationMembers: "最多 3 名成员",
				plusVaults: "5 个同步 vault",
				plusStorage: "50 GB 存储",
				plusStorageTooltip: "每个 vault 10 GB",
				plusFileSize: "最大文件 200 MB",
				plusHistory: "1 年版本历史",
			},
		},
		blog: {
			heading: "博客",
			empty: "还没有博客文章。",
			dateLocale: "zh-CN",
			ctaTitle: "准备同步你的 Obsidian vault？",
			ctaBody:
				"免费开始使用端到端加密同步；如果需要更多存储和更长版本历史，也可以比较方案。",
			ctaPrimary: "开始使用",
			ctaSecondary: "查看价格",
		},
		billing: {
			heading: "正在确认订阅",
			message: "正在应用你的订阅。这通常只需要几秒钟。",
			continue: "继续前往 Vaults",
			fallback: "仍在等待付款确认。你可以先继续，稍后再刷新。",
		},
		notFound: {
			eyebrow: "404",
			heading: "页面未找到",
			message: "该页面可能已移动，或链接不再有效。",
			home: "返回首页",
			pricing: "查看价格",
		},
		billingSettings: {
			eyebrow: "账单",
			heading: "管理订阅",
			subheading: "查看当前方案，并打开账单门户来更改或取消订阅。",
			loading: "正在加载账单状态...",
			currentPlan: "当前方案",
			renewal: "续订",
			endsOn: "结束于",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			monthly: "月付",
			annual: "年付",
			freeInterval: "免费",
			canceling: "将取消",
			canceled: "已取消",
			noRenewalDate: "无计划续订",
			activeMessage: "你的订阅处于有效状态。可打开账单门户更改方案、取消订阅或更新付款信息。",
			cancelingMessage: "你的订阅将在当前账单周期结束时取消。",
			canceledMessage: "你的订阅已取消。当前方案为免费。",
			freeMessage: "你目前使用免费方案。需要更多存储时可以升级。",
			manage: "管理订阅",
			upgrade: "查看方案",
			authRequired: "请登录以查看和管理订阅。",
			signIn: "登录",
			error: "无法加载账单信息。请稍后重试。",
			retry: "重试",
		},
	},
	"zh-tw": {
		meta: {
			defaultTitle: "Synch - 適用於 Obsidian 的開源端對端加密同步",
			defaultDescription:
				"Obsidian Sync 的開源替代方案。你的筆記會先在裝置上加密再離開裝置，確保隱私與資料控制權。",
			pricingTitle: "價格 - Synch",
			pricingDescription: "比較 Synch 適用於端對端加密 Obsidian vault 同步的方案與儲存限制。",
			blogTitle: "部落格 - Synch",
			blogDescription: "關於端對端加密 Obsidian 同步、隱私與 Synch 開發的文章。",
			billingTitle: "帳單 - Synch",
			billingDescription: "管理你的 Synch 訂閱與帳單設定。",
			billingSuccessTitle: "正在確認訂閱 - Synch",
			billingSuccessDescription: "正在確認你的 Synch 訂閱並套用到帳戶。",
			notFoundTitle: "找不到頁面 - Synch",
			notFoundDescription: "找不到你要求的頁面。",
		},
		nav: {
			pricing: "價格",
			github: "GitHub",
			signIn: "登入",
			signUp: "註冊",
			vaults: "Vaults",
			blog: "部落格",
			terms: "條款",
			privacy: "隱私",
		},
		home: {
			heroTitle: ["適用於 Obsidian 的", "端對端加密同步。"],
			featuredTitle: "了解更多",
			featuredPosts: [
				{
					title: "Synch 的端對端加密是如何運作的？",
					body: "用通俗方式說明 Synch 如何加密 vault 資料、保護 vault key，並在另一台裝置上安全開啟資料。",
					href: "/blog/encryption-and-decryption"
				}
			],
			heroBody:
				"Obsidian Sync 的開源替代方案。你的筆記會先在裝置上加密再離開裝置，確保隱私與資料控制權。",
			getStarted: "開始使用",
			viewSource: "查看原始碼",
			features: [
				{
					title: "3 秒同步",
					body: "Synch 會頻繁檢查變更，讓編輯內容可在幾秒內同步到其他裝置。",
				},
				{
					title: "版本記錄",
					body: "誤改內容後，可在方案保留期限內從同步檔案的加密記錄中復原。",
				},
				{
					title: "復原已刪除檔案",
					body: "已刪除的筆記和附件只要仍保留在版本記錄中，就可以找回。",
				},
				{
					title: "自動合併衝突",
					body: "當同一篇筆記在多台裝置上被修改時，Synch 會使用 3-way merge 自動合併相容的編輯。",
				},
			],
			installTitle: "如何安裝",
			installIntro: "請從 Obsidian 的 Community Plugins 目錄安裝 Synchrun。",
			installSteps: [
				["開啟 Obsidian 設定並前往", "Community plugins", "。"],
				["關閉受限模式，然後選擇", "Browse", "。"],
				["搜尋", "Synchrun", "，選取後安裝。"],
				["安裝完成後，啟用", "Synchrun", "。"],
			],
			selfHosting: {
				title: "使用自己的 Synch 伺服器",
				body: "你可以在 Cloudflare 免費帳號中建立 Synch 伺服器，並把它的位址填入 Obsidian 外掛。",
				link: "閱讀自行託管指南",
			},
		},
		pricing: {
			heading: "簡單透明的價格。",
			subheading: "免費開始同步你的 vault。",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			plusPlan: "Sync Plus",
			forever: "/ 永久",
			month: "/ 月",
			year: "/ 年",
			monthly: "月付",
			annual: "年付",
			comingSoon: "即將推出",
			features: {
				oneVault: "1 個同步 vault",
				freeStorage: "50 MB 儲存空間",
				starterStorage: "1 GB 儲存空間",
				freeFileSize: "最大檔案 3 MB",
				starterFileSize: "最大檔案 5 MB",
				freeHistory: "1 天版本記錄",
				starterHistory: "1 個月版本記錄",
				plusOrganizationMembers: "最多 3 名成員",
				plusVaults: "5 個同步 vault",
				plusStorage: "50 GB 儲存空間",
				plusStorageTooltip: "每個 vault 10 GB",
				plusFileSize: "最大檔案 200 MB",
				plusHistory: "1 年版本記錄",
			},
		},
		blog: {
			heading: "部落格",
			empty: "尚未新增部落格文章。",
			dateLocale: "zh-TW",
			ctaTitle: "準備同步你的 Obsidian vault？",
			ctaBody:
				"免費開始使用端對端加密同步；如果需要更多儲存空間和更長版本記錄，也可以比較方案。",
			ctaPrimary: "開始使用",
			ctaSecondary: "查看價格",
		},
		billing: {
			heading: "正在確認訂閱",
			message: "正在套用你的訂閱。通常只需要幾秒鐘。",
			continue: "繼續前往 Vaults",
			fallback: "仍在等待付款確認。你可以先繼續，稍後再重新整理。",
		},
		notFound: {
			eyebrow: "404",
			heading: "找不到頁面",
			message: "此頁面可能已移動，或連結已不再有效。",
			home: "返回首頁",
			pricing: "查看價格",
		},
		billingSettings: {
			eyebrow: "帳單",
			heading: "管理訂閱",
			subheading: "查看目前方案，並開啟帳單入口網站來變更或取消訂閱。",
			loading: "正在載入帳單狀態...",
			currentPlan: "目前方案",
			renewal: "續訂",
			endsOn: "結束於",
			freePlan: "Sync Free",
			starterPlan: "Sync Starter",
			monthly: "月付",
			annual: "年付",
			freeInterval: "免費",
			canceling: "將取消",
			canceled: "已取消",
			noRenewalDate: "無預定續訂",
			activeMessage: "你的訂閱處於有效狀態。可開啟帳單入口網站變更方案、取消訂閱或更新付款資訊。",
			cancelingMessage: "你的訂閱將在目前帳單週期結束時取消。",
			canceledMessage: "你的訂閱已取消。目前方案為免費。",
			freeMessage: "你目前使用免費方案。需要更多儲存空間時可以升級。",
			manage: "管理訂閱",
			upgrade: "查看方案",
			authRequired: "請登入以查看和管理訂閱。",
			signIn: "登入",
			error: "無法載入帳單資訊。請稍後重試。",
			retry: "重試",
		},
	},
} as const;
