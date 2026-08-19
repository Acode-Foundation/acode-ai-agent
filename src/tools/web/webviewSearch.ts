import { addResult, isAbortError, matchesDomainFilters, normalizeCount, splitDomainFilter, throwIfAborted } from "./request";
import { SearchError, type ExtractedContent, type SearchOptions, type SearchResponse, type SearchResult } from "./types";

const PAGE_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 32_000;
const CREATE_TIMEOUT_MS = 8_000;
const SETTLE_MS = 280;
const RETRY_SETTLE_MS = 900;
const MAX_INLINE_CHARS = 24_000;

/** Pulls result cards from DDG HTML/lite, Bing, and generic SERP markup. */
const SEARCH_SCRAPE = `(function(){
	function txt(el){return (el&&(el.innerText||el.textContent)||"").replace(/\\s+/g," ").trim();}
	function unwrap(href){
		try{
			var u=new URL(href,location.href);
			var inner=u.searchParams.get("uddg")||u.searchParams.get("udg")||u.searchParams.get("url");
			if(!inner&&/\\/ck\\//.test(u.pathname)) inner=u.searchParams.get("u");
			return inner||u.href;
		}catch(e){return href||"";}
	}
	var out=[], seen={};
	function add(title,href,snippet){
		title=(title||"").replace(/\\s+/g," ").trim();
		var url=unwrap(href);
		if(!title||!url||seen[url]||title.length<2)return;
		seen[url]=1;
		out.push({title:title,url:url,snippet:(snippet||"").replace(/\\s+/g," ").trim().slice(0,420)});
	}
	document.querySelectorAll(".result").forEach(function(el){
		if(el.classList.contains("result--ad")||el.classList.contains("result--more"))return;
		var a=el.querySelector(".result__a, a.result__a");
		if(!a)return;
		add(txt(a),a.getAttribute("href")||a.href,txt(el.querySelector(".result__snippet,.result__body,.result__extras")));
	});
	document.querySelectorAll("a.result-link").forEach(function(a){
		var row=a.closest("tr")||a.parentElement;
		add(txt(a),a.getAttribute("href")||a.href,txt(row&&row.querySelector(".result-snippet,td.result-snippet")));
	});
	document.querySelectorAll("#b_results .b_algo, li.b_algo").forEach(function(el){
		var a=el.querySelector("h2 a, a[h]");
		if(!a)return;
		add(txt(a),a.href,txt(el.querySelector(".b_caption p,.b_lineclamp,.b_algoSlug,.b_snippet")));
	});
	if(out.length<3){
		document.querySelectorAll("h2 a[href], h3 a[href], a[data-testid='result-title-a']").forEach(function(a){
			var block=a.closest("article,li,div")||a.parentElement;
			add(txt(a),a.href,txt(block&&block.querySelector("p,span,div")));
		});
	}
	return JSON.stringify(out);
})()`;

const PAGE_SCRAPE = `(function(){
	var MAX=${MAX_INLINE_CHARS};
	var drop="script,style,noscript,svg,iframe,canvas,form,nav,footer,header,aside,button,input,textarea,select,[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary'],[aria-hidden='true']";
	var junk=/cookie|consent|onetrust|subscribe|newsletter|paywall|sign[- ]?in|log[- ]?in|advert/i;
	function txt(el){return (el&&(el.innerText||el.textContent)||"").replace(/[ \\t]+/g," ").replace(/\\n{3,}/g,"\\n\\n").trim();}
	function cloneRoot(){
		var src=document.body; if(!src) return null;
		var root=src.cloneNode(true);
		root.querySelectorAll(drop).forEach(function(n){n.remove();});
		root.querySelectorAll("[class],[id]").forEach(function(n){
			var id=(n.id||"")+" "+(n.className&&n.className.toString?n.className.toString():"");
			if(junk.test(id)) n.remove();
		});
		return root;
	}
	function score(el){
		var t=txt(el); if(t.length<120) return 0;
		var p=el.querySelectorAll("p").length;
		var h=el.querySelectorAll("h1,h2,h3").length;
		var code=el.querySelectorAll("pre,code").length;
		var links=el.querySelectorAll("a").length;
		var s=Math.min(t.length,12000)/50+p*14+h*10+code*22;
		if(el.matches&&el.matches("article,main,[role='main']")) s+=90;
		if(links>Math.max(8,p*4)) s-=50;
		return s;
	}
	function toMarkdown(root){
		var blocks=[];
		function walk(node){
			if(!node) return;
			if(node.nodeType===3){
				var value=node.nodeValue.replace(/\\s+/g," ").trim();
				if(value) blocks.push(value);
				return;
			}
			if(node.nodeType!==1) return;
			var tag=node.tagName.toLowerCase();
			if(/^(script|style|noscript|svg|iframe)$/.test(tag)) return;
			if(/^h[1-6]$/.test(tag)){ blocks.push("\\n"+Array(+tag[1]+1).join("#")+" "+txt(node)+"\\n"); return; }
			if(tag==="pre"){ blocks.push("\\n\`\`\`\\n"+(node.innerText||"").trim()+"\\n\`\`\`\\n"); return; }
			if(tag==="li"){ blocks.push("- "+txt(node)); return; }
			if(tag==="p"||tag==="blockquote"){ blocks.push(txt(node)); return; }
			if(tag==="br"){ blocks.push(""); return; }
			if(tag==="a"){
				var href=node.getAttribute("href")||"";
				var label=txt(node);
				blocks.push(label&&href&&!href.startsWith("#")?("["+label+"]("+href+")"):label);
				return;
			}
			if(tag==="code"&&(!node.parentElement||node.parentElement.tagName.toLowerCase()!=="pre")){
				blocks.push("\`"+txt(node)+"\`");
				return;
			}
			for(var i=0;i<node.childNodes.length;i++) walk(node.childNodes[i]);
		}
		walk(root);
		return blocks.join("\\n").replace(/\\n{3,}/g,"\\n\\n").trim();
	}
	var root=cloneRoot();
	var best=root, bestScore=root?score(root):0;
	if(root){
		root.querySelectorAll("article,main,[role='main'],section,div").forEach(function(el){
			var s=score(el);
			if(s>bestScore){ best=el; bestScore=s; }
		});
	}
	var title=(document.querySelector("meta[property='og:title']")||{}).content
		|| (document.querySelector("h1")&&txt(document.querySelector("h1")))
		|| document.title
		|| location.hostname;
	var content=best?toMarkdown(best):txt(document.body);
	if(content.length<80) content=txt(document.body);
	return JSON.stringify({title:String(title||"").replace(/\\s+/g," ").trim(),content:content.slice(0,MAX)});
})()`;

export function getWebViewApi(): Acode.WebViewApi | undefined {
	try {
		const api = acode.require("webview") as Acode.WebViewApi | undefined;
		return api && typeof api.create === "function" ? api : undefined;
	} catch {
		return undefined;
	}
}

export async function searchWithWebView(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const encoded = encodeURIComponent(withRecency(query, options));
	const results = await withHiddenWebView(options.signal, async (view) => {
		for (const [url, match] of [
			[`https://html.duckduckgo.com/html/?q=${encoded}`, "duckduckgo.com"],
			[`https://lite.duckduckgo.com/lite/?q=${encoded}`, "duckduckgo.com"],
			[`https://www.bing.com/search?q=${encoded}`, "bing.com"],
		] as const) {
			const found = await scrape(view, url, SEARCH_SCRAPE, options, (href) => href.includes(match));
			if (found.length) return found;
		}
		return [];
	});
	if (!results.length) throw new SearchError("webview", "invalid-response", "Device search returned no parseable results.");
	return { provider: "webview", answer: "", results };
}

export async function fetchViaWebView(url: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const scraped = await withHiddenWebView(signal, async (view) => {
		const raw = await loadAndEvaluate(view, url, PAGE_SCRAPE, signal);
		return parseJson(raw) as { title?: string; content?: string } | undefined;
	});
	const content = typeof scraped?.content === "string" ? scraped.content.trim() : "";
	if (!content) throw new SearchError("webview", "invalid-response", "Device WebView returned empty page text.");
	return {
		url,
		title: typeof scraped?.title === "string" && scraped.title.trim() ? scraped.title.trim() : url,
		content: content.slice(0, MAX_INLINE_CHARS),
	};
}

export function parseScrapedResults(value: unknown, options: SearchOptions = {}): SearchResult[] {
	const items = Array.isArray(value) ? value : parseJson(value);
	if (!Array.isArray(items)) return [];
	const filters = splitDomainFilter(options.domainFilter);
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const record = item as { title?: unknown; url?: unknown; snippet?: unknown };
		if (typeof record.url !== "string" || !matchesDomainFilters(record.url, filters)) continue;
		addResult(results, seen, record.url, record.title, typeof record.snippet === "string" ? record.snippet : "");
		if (results.length >= normalizeCount(options.numResults)) break;
	}
	return results;
}

export function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const once = JSON.parse(value) as unknown;
		return typeof once === "string" ? JSON.parse(once) : once;
	} catch {
		return undefined;
	}
}

async function withHiddenWebView<T>(signal: AbortSignal | undefined, task: (view: Acode.WebViewInstance) => Promise<T>): Promise<T> {
	const api = getWebViewApi();
	if (!api) throw new SearchError("webview", "credential", "Acode WebView API is not available on this build.");
	throwIfAborted(signal);
	const view = await withTimeout(api.create({ mode: "hidden", allowNavigation: true, visible: false }), CREATE_TIMEOUT_MS, "Device browser failed to start.", signal);
	const onAbort = () => {
		void view.destroy().catch(() => undefined);
	};
	signal?.addEventListener("abort", onAbort);
	try {
		throwIfAborted(signal);
		return await withTimeout(task(view), SEARCH_TIMEOUT_MS, "Device search timed out.", signal);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await view.destroy().catch(() => undefined);
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new SearchError("webview", "transient", message)), timeoutMs);
		const onAbort = () => finish(new DOMException("Operation aborted", "AbortError"));
		const finish = (error?: unknown, value?: T) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(value as T);
		};
		if (signal?.aborted) {
			finish(new DOMException("Operation aborted", "AbortError"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => finish(undefined, value), (error) => finish(error));
	});
}

async function scrape(
	view: Acode.WebViewInstance,
	url: string,
	script: string,
	options: SearchOptions,
	match?: (url: string) => boolean,
): Promise<SearchResult[]> {
	try {
		const first = parseScrapedResults(await loadAndEvaluate(view, url, script, options.signal, match), options);
		if (first.length) return first;
		await settle(options.signal, RETRY_SETTLE_MS);
		return parseScrapedResults(await view.evaluate(script), options);
	} catch (error) {
		if (isAbortError(error)) throw error;
		return [];
	}
}

async function loadAndEvaluate(
	view: Acode.WebViewInstance,
	url: string,
	script: string,
	signal: AbortSignal | undefined,
	match?: (url: string) => boolean,
): Promise<unknown> {
	const finished = waitForPage(view, signal, match);
	await view.loadURL(url);
	await finished;
	await settle(signal, SETTLE_MS);
	return view.evaluate(script);
}

function waitForPage(view: Acode.WebViewInstance, signal: AbortSignal | undefined, match?: (url: string) => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("Page load timed out")), PAGE_TIMEOUT_MS);
		const onAbort = () => finish(new DOMException("Operation aborted", "AbortError"));
		const onPage: Acode.WebViewEventCallback = (_event, data) => {
			const url = data && typeof data === "object" && "url" in data ? String((data as { url?: unknown }).url ?? "") : "";
			if (url === "about:blank") return;
			if (match && url && !match(url)) return;
			finish();
		};
		const finish = (error?: Error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			view.off("pageFinished", onPage);
			if (error) reject(error);
			else resolve();
		};
		if (signal?.aborted) {
			finish(new DOMException("Operation aborted", "AbortError"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		view.on("pageFinished", onPage);
	});
}

function settle(signal: AbortSignal | undefined, ms: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Operation aborted", "AbortError"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function withRecency(query: string, options: SearchOptions): string {
	if (!options.recencyFilter) return query;
	const labels = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
	return `${query} ${labels[options.recencyFilter]}`;
}
