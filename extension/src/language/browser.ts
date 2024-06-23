import vscode from 'vscode';
import axios from 'axios';
import { HTMLElement, parse } from 'node-html-parser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tail<T extends any[]> = T extends [any, ...infer Tail] ? Tail : never;

export class GoplsBrowser {
	readonly panel: vscode.WebviewPanel;

	constructor(url: string, ...options: Tail<Parameters<typeof vscode.window.createWebviewPanel>>) {
		this.panel = vscode.window.createWebviewPanel('gopls', ...options);

		this.panel.webview.onDidReceiveMessage(async (e) => {
			switch (e.command) {
				case 'navigate':
					this.#navigate(e.url);
					break;

				case 'back':
					this.#back();
					break;

				case 'forward':
					this.#forward();
					break;
			}
		});

		this.#navigate(url);
	}

	readonly #history: string[] = [];
	readonly #unhistory: string[] = [];
	#current?: string;

	#navigate(url: string) {
		this.#load(url)
			.then((r) => {
				if (r !== false) {
					this.#history.push(url);
					this.#unhistory.splice(0, this.#unhistory.length);
				}
			})
			.catch((e) => this.#onError(e));
	}

	#back() {
		if (this.#history.length < 2) {
			return;
		}

		this.#unhistory.push(this.#history.pop()!);
		const url = this.#history[this.#history.length - 1];
		this.#load(url).catch((e) => this.#onError(e));
	}

	#forward() {
		if (this.#unhistory.length < 1) {
			return;
		}

		const url = this.#unhistory.pop()!;
		this.#history.push(url);
		this.#load(url).catch((e) => this.#onError(e));
	}

	#onError(error: unknown) {
		console.error('Navigation failed', error);
	}

	async #load(url: string) {
		const page = vscode.Uri.parse(url);
		const pageStr = page.with({ fragment: '' }).toString(true);
		if (pageStr === this.#current) {
			this.panel.webview.postMessage({
				command: 'jump',
				fragment: page.fragment
			});
			return;
		} else {
			this.#current = pageStr;
		}

		const base = (await vscode.env.asExternalUri(page.with({ path: '', query: '', fragment: '' })))
			.toString(true)
			.replace(/\/$/, '');

		// Fetch data
		const { data } = await axios.get<string>(url);

		// If the response is empty, assume it was opening a source file and
		// ignore it
		if (!data) return false;

		// Process the response
		const document = parse(data);
		const head = document.querySelector('head')!;

		// Note, gopls's response does not include <body>, all content is a
		// direct child of <html>

		// Add the base URL to head children and the logo <img>
		const baseStr = base;
		const addBase = (s: string) => (s.startsWith('/') ? `${baseStr}${s}` : s);
		fixLinks(head, addBase);
		fixLinks(document.getElementById('pkgsite'), addBase);

		// Add <base> to fix queries
		head.appendChild(parse(`<base href="${base}" />`));

		// Globals
		head.appendChild(
			parse(`
				<script>
					const vscode = acquireVsCodeApi();

					const goTo = (url) => vscode.postMessage({ command: 'navigate', url });
					const goBack = () => vscode.postMessage({ command: 'back' });
					const goForward = () => vscode.postMessage({ command: 'forward' });
					const jumpTo = (hash) => location.hash = hash;

					addEventListener('message', event => {
						switch (event.data.command) {
							case 'jump':
								jumpTo(event.data.fragment);
								break;
						}
					});
				</script>
			`)
		);

		// Capture navigation
		head.appendChild(
			parse(`
				<script>
					addEventListener('load', () => {
						document.querySelectorAll('a[href^="${pageStr}#"]').forEach(el => {
							const s = el.getAttribute('href');
							el.setAttribute('href', s.replace("${pageStr}", ''))
						})

						document.querySelectorAll('a[href^="#"]').forEach(el => {
							el.addEventListener('click', (event) => {
								goTo("${pageStr}" + el.getAttribute('href'));
							})
						})

						document.querySelectorAll('a:not([href^="#"])').forEach(el => {
							el.addEventListener('click', (event) => {
								event.preventDefault();
								event.stopImmediatePropagation();
								goTo(el.getAttribute('href'));
							})
						})
					})
				</script>
			`)
		);

		// Add <style> to apply VSCode's theme
		document.appendChild(
			parse(`
				<style>
					body {
						background-color: var(--vscode-editor-background);
						color: var(--vscode-editor-foreground);
					}

					header {
						display: none;
					}

					pre {
						background-color: var(--vscode-textCodeBlock-background);
						border: 1px solid var(--vscode-widget-border);
					}

					a, a:link, a:visited, a code {
						color: var(--vscode-textLink-foreground);
					}

					.clicky {
						cursor: pointer;
					}
				</style>
			`)
		);

		// If there's an anchor, jump to it
		if (page.fragment) {
			document.appendChild(parse(`<script>jumpTo("${page.fragment}")</script>`));
		}

		// Update the webview
		this.panel.webview.html = document.toString();
	}
}

function fixLinks(elem: HTMLElement | null, fix: (url: string) => string) {
	if (!elem) return;

	if (elem.attrs.href) {
		elem.setAttribute('href', fix(elem.attrs.href));
	}
	if (elem.attrs.src) {
		elem.setAttribute('src', fix(elem.attrs.src));
	}

	for (const node of elem.childNodes) {
		if (node instanceof HTMLElement) {
			fixLinks(node, fix);
		}
	}
}
