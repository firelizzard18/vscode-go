import vscode from 'vscode';
import axios from 'axios';
import { HTMLElement, parse } from 'node-html-parser';

interface TreeItem {
	label: string;
	id: string;
	children?: TreeItem[];
	command?: vscode.Command;
}

class TreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
	readonly #didChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.#didChangeTreeData.event;

	#items?: TreeItem[];

	show() {
		vscode.commands.executeCommand('setContext', 'gopls.showDocBrowser', true);
	}

	hide() {
		vscode.commands.executeCommand('setContext', 'gopls.showDocBrowser', false);
	}

	set items(items: TreeItem[]) {
		this.#items = items;
		this.#didChangeTreeData.fire();
	}

	getChildren(element?: TreeItem | undefined): vscode.ProviderResult<TreeItem[]> {
		if (element) {
			return element.children;
		}
		return this.#items;
	}

	getTreeItem(element: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return {
			...element,
			collapsibleState: element.children?.length
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None
		};
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tail<T extends any[]> = T extends [any, ...infer Tail] ? Tail : never;

export class GoplsBrowser {
	static readonly treeDataProvider = new TreeDataProvider();
	static #ctx: vscode.ExtensionContext;
	static active?: GoplsBrowser;

	static activate(ctx: vscode.ExtensionContext) {
		this.#ctx = ctx;
		ctx.subscriptions.push(vscode.window.registerTreeDataProvider('gopls.docBrowser', this.treeDataProvider));

		ctx.subscriptions.push(
			vscode.commands.registerCommand('gopls.docBrowser.jumpTo', (url: string) => {
				this.active?.navigate(url);
			})
		);
	}

	readonly panel: vscode.WebviewPanel;
	readonly #extensionUri: vscode.Uri;

	constructor(url: string, ...options: Tail<Parameters<typeof vscode.window.createWebviewPanel>>) {
		this.#extensionUri = GoplsBrowser.#ctx.extensionUri;
		this.panel = vscode.window.createWebviewPanel('gopls', ...options);

		this.panel.onDidDispose(() => {
			GoplsBrowser.treeDataProvider.hide();
		});
		this.panel.onDidChangeViewState((e) => {
			if (e.webviewPanel.active) {
				GoplsBrowser.treeDataProvider.show();
				GoplsBrowser.active = this;
			} else {
				GoplsBrowser.treeDataProvider.hide();
			}
		});

		this.panel.webview.onDidReceiveMessage(async (e) => {
			switch (e.command) {
				case 'navigate':
					this.navigate(e.url);
					break;

				case 'back':
					this.#back();
					break;

				case 'forward':
					this.#forward();
					break;

				case 'reload':
					this.#reload();
					break;
			}
		});

		this.navigate(url);
	}

	readonly #history: string[] = [];
	readonly #unhistory: string[] = [];
	#current?: string;

	navigate(url: string) {
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

	#reload() {
		this.#load(this.#history[this.#history.length - 1], true).catch((e) => this.#onError(e));
	}

	#onError(error: unknown) {
		console.error('Navigation failed', error);
	}

	async #load(url: string, reload = false) {
		const page = vscode.Uri.parse(url);
		const pageStr = page.with({ fragment: '' }).toString(true);
		if (!reload && pageStr === this.#current) {
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

		// If there's an anchor, jump to it
		if (page.fragment) {
			document.appendChild(parse(`<script>jumpTo("${page.fragment}")</script>`));
		}

		// Add <base> to fix queries
		head.appendChild(parse(`<base href="${base}" />`));

		// Transfer variables
		head.appendChild(parse(`<script>const pageStr = "${pageStr}";</script>`));

		// Add resources
		head.appendChild(parse(`<script src="${this.#contentUri('main.js')}"></script>`));
		head.appendChild(parse(`<link rel="stylesheet" href="${this.#contentUri('main.css')}" />`));

		// Add navigation widget
		document.appendChild(
			parse(`
				<nav>
					<ul>
						<li onclick="goBack()">⇽</li>
						<li onclick="reload()">⟳</li>
						<li onclick="goForward()">⇾</li>
					</ul>
				</nav>
			`)
		);

		// Check for gopls navigation
		const selector = document.querySelector('header > select');
		let showTree = selector?.id === 'hdr-Selector';
		if (showTree) {
			const items = selector!.childNodes
				.filter((n): n is HTMLElement => n instanceof HTMLElement)
				.filter((el) => el.tagName === 'OPTGROUP')
				.map((el) => ({
					label: el.attributes.label,
					id: `section$${el.attributes.label}`,
					children: el.childNodes
						.filter((n): n is HTMLElement => n instanceof HTMLElement)
						.filter((el) => el.tagName === 'OPTION')
						.map((el) => ({
							label: el.attributes.label,
							id: el.attributes.value.replace(/^#/, ''),
							command: {
								title: 'Open',
								command: 'gopls.docBrowser.jumpTo',
								arguments: [`${pageStr}${el.attributes.value}`]
							}
						}))
				}));
			GoplsBrowser.treeDataProvider.items = items;
			showTree = items.length > 0;
		}
		if (showTree) {
			GoplsBrowser.treeDataProvider.show();
		} else {
			GoplsBrowser.treeDataProvider.hide();
		}

		// Update the webview (trigger a reload)
		this.panel.webview.html = ' ';
		this.panel.webview.html = document.toString();
	}

	#contentUri(...path: string[]) {
		const uri = vscode.Uri.joinPath(this.#extensionUri, 'webview', 'browser', ...path);
		return this.panel.webview.asWebviewUri(uri);
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
