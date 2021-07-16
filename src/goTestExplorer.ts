import {
	test,
	workspace,
	ExtensionContext,
	TestController,
	TestItem,
	TextDocument,
	Uri,
	DocumentSymbol,
	SymbolKind,
	FileType,
	WorkspaceFolder,
	TestRunRequest,
	OutputChannel,
	TestResultState,
	TestRun,
	TestMessageSeverity,
	Location,
	Position,
	TextDocumentChangeEvent,
	WorkspaceFoldersChangeEvent,
	CancellationToken,
	FileSystem as vsFileSystem,
	workspace as vsWorkspace
} from 'vscode';
import path = require('path');
import { getModFolderPath, isModSupported } from './goModules';
import { getCurrentGoPath } from './util';
import { GoDocumentSymbolProvider } from './goOutline';
import { getGoConfig } from './config';
import { getTestFlags, goTest, GoTestOutput } from './testUtils';

// We could use TestItem.data, but that may be removed
const symbols = new WeakMap<TestItem, DocumentSymbol>();

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace TestExplorer {
	// exported for tests

	export type FileSystem = Pick<vsFileSystem, 'readFile' | 'readDirectory'>;

	export interface Workspace extends Pick<typeof vsWorkspace, 'workspaceFolders' | 'getWorkspaceFolder'> {
		readonly fs: FileSystem; // custom FS type

		openTextDocument(uri: Uri): Thenable<TextDocument>; // only one overload
	}
}

export class TestExplorer {
	static setup(context: ExtensionContext) {
		const ctrl = test.createTestController('go');
		const inst = new this(
			ctrl,
			workspace,
			(e) => console.log(e),
			new GoDocumentSymbolProvider().provideDocumentSymbols
		);

		context.subscriptions.push(workspace.onDidOpenTextDocument((x) => inst.didOpenTextDocument(x)));
		context.subscriptions.push(workspace.onDidChangeTextDocument((x) => inst.didChangeTextDocument(x)));
		context.subscriptions.push(workspace.onDidChangeWorkspaceFolders((x) => inst.didChangeWorkspaceFolders(x)));

		const watcher = workspace.createFileSystemWatcher('**/*_test.go', false, true, false);
		context.subscriptions.push(watcher);
		context.subscriptions.push(watcher.onDidCreate((x) => inst.didCreateFile(x)));
		context.subscriptions.push(watcher.onDidDelete((x) => inst.didDeleteFile(x)));
	}

	constructor(
		public ctrl: TestController,
		public ws: TestExplorer.Workspace,
		public errored: (e: unknown) => void,
		public provideDocumentSymbols: (doc: TextDocument, token: CancellationToken) => Thenable<DocumentSymbol[]>
	) {
		// TODO handle cancelation of test runs
		ctrl.root.label = 'Go';
		ctrl.root.canResolveChildren = true;
		ctrl.resolveChildrenHandler = (...args) => resolveChildren(this, ...args);
		ctrl.runHandler = (request) => runTest(this, request);
	}

	async didOpenTextDocument(doc: TextDocument) {
		try {
			await documentUpdate(this, doc);
		} catch (e) {
			this.errored(e);
		}
	}

	async didChangeTextDocument(e: TextDocumentChangeEvent) {
		try {
			await documentUpdate(
				this,
				e.document,
				e.contentChanges.map((x) => x.range)
			);
		} catch (e) {
			this.errored(e);
		}
	}

	async didChangeWorkspaceFolders(e: WorkspaceFoldersChangeEvent) {
		const items = Array.from(this.ctrl.root.children.values());
		for (const item of items) {
			const uri = Uri.parse(item.id);
			if (uri.query === 'package') {
				continue;
			}

			const ws = this.ws.getWorkspaceFolder(uri);
			if (!ws) {
				item.dispose();
			}
		}

		if (e.added) {
			await resolveChildren(this, this.ctrl.root);
		}
	}

	async didCreateFile(file: Uri) {
		try {
			await documentUpdate(this, await this.ws.openTextDocument(file));
		} catch (e) {
			this.errored(e);
		}
	}

	async didDeleteFile(file: Uri) {
		const id = testID(file, 'file');
		function find(parent: TestItem): TestItem {
			for (const item of parent.children.values()) {
				if (item.id === id) {
					return item;
				}

				const uri = Uri.parse(item.id);
				if (!file.path.startsWith(uri.path)) {
					continue;
				}

				const found = find(item);
				if (found) {
					return found;
				}
			}
		}

		const found = find(this.ctrl.root);
		if (found) {
			found.dispose();
			disposeIfEmpty(found.parent);
		}
	}
}

// Construct an ID for an item.
// - Module:    file:///path/to/mod?module
// - Package:   file:///path/to/mod/pkg?package
// - File:      file:///path/to/mod/file.go?file
// - Test:      file:///path/to/mod/file.go?test#TestXxx
// - Benchmark: file:///path/to/mod/file.go?benchmark#BenchmarkXxx
// - Example:   file:///path/to/mod/file.go?example#ExampleXxx
function testID(uri: Uri, kind: string, name?: string): string {
	uri = uri.with({ query: kind });
	if (name) uri = uri.with({ fragment: name });
	return uri.toString();
}

// Retrieve a child item.
function getItem(parent: TestItem, uri: Uri, kind: string, name?: string): TestItem | undefined {
	return parent.children.get(testID(uri, kind, name));
}

// Create or Retrieve a child item.
function getOrCreateItem(
	{ ctrl }: TestExplorer,
	parent: TestItem,
	label: string,
	uri: Uri,
	kind: string,
	name?: string
): TestItem {
	const id = testID(uri, kind, name);
	const existing = parent.children.get(id);
	if (existing) {
		return existing;
	}

	return ctrl.createTestItem(id, label, parent, uri.with({ query: '', fragment: '' }));
}

// Create or Retrieve a sub test or benchmark. The ID will be of the form:
//     file:///path/to/mod/file.go?test#TestXxx/A/B/C
function getOrCreateSubTest({ ctrl }: TestExplorer, item: TestItem, name: string): TestItem {
	let uri = Uri.parse(item.id);
	uri = uri.with({ fragment: `${uri.fragment}/${name}` });
	const existing = item.children.get(uri.toString());
	if (existing) {
		return existing;
	}

	item.canResolveChildren = true;
	const sub = ctrl.createTestItem(uri.toString(), name, item, item.uri);
	sub.runnable = false;
	sub.range = item.range;
	return sub;
}

// Dispose of the item if it has no children, recursively. This facilitates
// cleaning up package/file trees that contain no tests.
function disposeIfEmpty(item: TestItem) {
	// Don't dispose of the root
	if (!item.parent) {
		return;
	}

	// Don't dispose of empty modules
	const uri = Uri.parse(item.id);
	if (uri.query === 'module') {
		return;
	}

	if (item.children.size) {
		return;
	}

	item.dispose();
	disposeIfEmpty(item.parent);
}

// Dispose of the children of a test. Sub-tests and sub-benchmarks are
// discovered emperically (from test output) not semantically (from code), so
// there are situations where they must be discarded.
function discardChildren(item: TestItem) {
	item.canResolveChildren = false;
	Array.from(item.children.values()).forEach((x) => x.dispose());
}

// If a test/benchmark with children is relocated, update the children's
// location.
function relocateChildren(item: TestItem) {
	for (const child of item.children.values()) {
		child.range = item.range;
		relocateChildren(child);
	}
}

// Retrieve or create an item for a Go module.
async function getModule(expl: TestExplorer, uri: Uri): Promise<TestItem> {
	const existing = getItem(expl.ctrl.root, uri, 'module');
	if (existing) {
		return existing;
	}

	// Use the module name as the label
	const goMod = Uri.joinPath(uri, 'go.mod');
	const contents = await expl.ws.fs.readFile(goMod);
	const modLine = contents.toString().split('\n', 2)[0];
	const match = modLine.match(/^module (?<name>.*?)(?:\s|\/\/|$)/);
	const item = getOrCreateItem(expl, expl.ctrl.root, match.groups.name, uri, 'module');
	item.canResolveChildren = true;
	item.runnable = true;
	return item;
}

// Retrieve or create an item for a workspace folder that is not a module.
async function getWorkspace(expl: TestExplorer, ws: WorkspaceFolder): Promise<TestItem> {
	const existing = getItem(expl.ctrl.root, ws.uri, 'workspace');
	if (existing) {
		return existing;
	}

	// Use the workspace folder name as the label
	const item = getOrCreateItem(expl, expl.ctrl.root, ws.name, ws.uri, 'workspace');
	item.canResolveChildren = true;
	item.runnable = true;
	return item;
}

// Retrieve or create an item for a Go package.
async function getPackage(expl: TestExplorer, uri: Uri): Promise<TestItem> {
	let item: TestItem;

	const modDir = await getModFolderPath(uri, true);
	const wsfolder = workspace.getWorkspaceFolder(uri);
	if (modDir) {
		// If the package is in a module, add it as a child of the module
		const modUri = uri.with({ path: modDir, query: '', fragment: '' });
		const module = await getModule(expl, modUri);
		const existing = getItem(module, uri, 'package');
		if (existing) {
			return existing;
		}

		if (uri.path === modUri.path) {
			return module;
		}

		const label = uri.path.startsWith(modUri.path) ? uri.path.substring(modUri.path.length + 1) : uri.path;
		item = getOrCreateItem(expl, module, label, uri, 'package');
	} else if (wsfolder) {
		// If the package is in a workspace folder, add it as a child of the workspace
		const workspace = await getWorkspace(expl, wsfolder);
		const existing = getItem(workspace, uri, 'package');
		if (existing) {
			return existing;
		}

		const label = uri.path.startsWith(wsfolder.uri.path)
			? uri.path.substring(wsfolder.uri.path.length + 1)
			: uri.path;
		item = getOrCreateItem(expl, workspace, label, uri, 'package');
	} else {
		// Otherwise, add it directly to the root
		const existing = getItem(expl.ctrl.root, uri, 'package');
		if (existing) {
			return existing;
		}

		const srcPath = path.join(getCurrentGoPath(uri), 'src');
		const label = uri.path.startsWith(srcPath) ? uri.path.substring(srcPath.length + 1) : uri.path;
		item = getOrCreateItem(expl, expl.ctrl.root, label, uri, 'package');
	}

	item.canResolveChildren = true;
	item.runnable = true;
	return item;
}

// Retrieve or create an item for a Go file.
async function getFile(expl: TestExplorer, uri: Uri): Promise<TestItem> {
	const dir = path.dirname(uri.path);
	const pkg = await getPackage(expl, uri.with({ path: dir, query: '', fragment: '' }));
	const existing = getItem(pkg, uri, 'file');
	if (existing) {
		return existing;
	}

	const label = path.basename(uri.path);
	const item = getOrCreateItem(expl, pkg, label, uri, 'file');
	item.canResolveChildren = true;
	item.runnable = true;
	return item;
}

// Recursively process a Go AST symbol. If the symbol represents a test,
// benchmark, or example function, a test item will be created for it, if one
// does not already exist. If the symbol is not a function and contains
// children, those children will be processed recursively.
async function processSymbol(expl: TestExplorer, uri: Uri, file: TestItem, seen: Set<string>, symbol: DocumentSymbol) {
	// Skip TestMain(*testing.M) - allow TestMain(*testing.T)
	if (symbol.name === 'TestMain' && /\*testing.M\)/.test(symbol.detail)) {
		return;
	}

	// Recursively process symbols that are nested
	if (symbol.kind !== SymbolKind.Function) {
		for (const sym of symbol.children) await processSymbol(expl, uri, file, seen, sym);
		return;
	}

	const match = symbol.name.match(/^(?<type>Test|Example|Benchmark)/);
	if (!match) {
		return;
	}

	seen.add(symbol.name);

	const kind = match.groups.type.toLowerCase();
	const existing = getItem(file, uri, kind, symbol.name);
	if (existing) {
		if (!existing.range.isEqual(symbol.range)) {
			existing.range = symbol.range;
			relocateChildren(existing);
		}
		return existing;
	}

	const item = getOrCreateItem(expl, file, symbol.name, uri, kind, symbol.name);
	item.range = symbol.range;
	item.runnable = true;
	// item.debuggable = true;
	symbols.set(item, symbol);
}

// Processes a Go document, calling processSymbol for each symbol in the
// document.
//
// Any previously existing tests that no longer have a corresponding symbol in
// the file will be disposed. If the document contains no tests, it will be
// disposed.
async function processDocument(expl: TestExplorer, doc: TextDocument, ranges?: Range[]) {
	const seen = new Set<string>();
	const item = await getFile(expl, doc.uri);
	const symbols = await expl.provideDocumentSymbols(doc, null);
	for (const symbol of symbols) await processSymbol(expl, doc.uri, item, seen, symbol);

	for (const child of item.children.values()) {
		const uri = Uri.parse(child.id);
		if (!seen.has(uri.fragment)) {
			child.dispose();
			continue;
		}

		if (ranges?.some((r) => !!child.range.intersection(r))) {
			discardChildren(child);
		}
	}

	disposeIfEmpty(item);
}

// Reasons to stop walking
enum WalkStop {
	None = 0, // Don't stop
	Abort, // Abort the walk
	Current, // Stop walking the current directory
	Files, // Skip remaining files
	Directories // Skip remaining directories
}

// Recursively walk a directory, breadth first.
async function walk(
	fs: TestExplorer.FileSystem,
	uri: Uri,
	cb: (dir: Uri, file: string, type: FileType) => Promise<WalkStop | undefined>
): Promise<void> {
	let dirs = [uri];

	// While there are directories to be scanned
	while (dirs.length > 0) {
		const d = dirs;
		dirs = [];

		outer: for (const uri of d) {
			const dirs2 = [];
			let skipFiles = false,
				skipDirs = false;

			// Scan the directory
			inner: for (const [file, type] of await fs.readDirectory(uri)) {
				if ((skipFiles && type === FileType.File) || (skipDirs && type === FileType.Directory)) {
					continue;
				}

				// Ignore all dotfiles
				if (file.startsWith('.')) {
					continue;
				}

				if (type === FileType.Directory) {
					dirs2.push(Uri.joinPath(uri, file));
				}

				const s = await cb(uri, file, type);
				switch (s) {
					case WalkStop.Abort:
						// Immediately abort the entire walk
						return;

					case WalkStop.Current:
						// Immediately abort the current directory
						continue outer;

					case WalkStop.Files:
						// Skip all subsequent files in the current directory
						skipFiles = true;
						if (skipFiles && skipDirs) {
							break inner;
						}
						break;

					case WalkStop.Directories:
						// Skip all subsequent directories in the current directory
						skipDirs = true;
						if (skipFiles && skipDirs) {
							break inner;
						}
						break;
				}
			}

			// Add subdirectories to the recursion list
			dirs.push(...dirs2);
		}
	}
}

// Walk the workspace, looking for Go modules. Returns a map indicating paths
// that are modules (value == true) and paths that are not modules but contain
// Go files (value == false).
async function walkWorkspaces(fs: TestExplorer.FileSystem, uri: Uri): Promise<Map<string, boolean>> {
	const found = new Map<string, boolean>();
	await walk(fs, uri, async (dir, file, type) => {
		if (type !== FileType.File) {
			return;
		}

		if (file === 'go.mod') {
			found.set(dir.toString(), true);
			return WalkStop.Current;
		}

		if (file.endsWith('.go')) {
			found.set(dir.toString(), false);
		}
	});
	return found;
}

// Walk the workspace, calling the callback for any directory that contains a Go
// test file.
async function walkPackages(fs: TestExplorer.FileSystem, uri: Uri, cb: (uri: Uri) => Promise<unknown>) {
	await walk(fs, uri, async (dir, file) => {
		if (file.endsWith('_test.go')) {
			await cb(dir);
			return WalkStop.Files;
		}
	});
}

// Handle opened documents, document changes, and file creation.
async function documentUpdate(expl: TestExplorer, doc: TextDocument, ranges?: Range[]) {
	if (!doc.uri.path.endsWith('_test.go')) {
		return;
	}

	if (doc.uri.scheme === 'git') {
		// TODO(firelizzard18): When a workspace is reopened, VSCode passes us git: URIs. Why?
		return;
	}

	await processDocument(expl, doc, ranges);
}

// TestController.resolveChildrenHandler callback
async function resolveChildren(expl: TestExplorer, item: TestItem) {
	// The user expanded the root item - find all modules and workspaces
	if (!item.parent) {
		// Dispose of package entries at the root if they are now part of a workspace folder
		const items = Array.from(expl.ctrl.root.children.values());
		for (const item of items) {
			const uri = Uri.parse(item.id);
			if (uri.query !== 'package') {
				continue;
			}

			if (expl.ws.getWorkspaceFolder(uri)) {
				item.dispose();
			}
		}

		// Create entries for all modules and workspaces
		for (const folder of expl.ws.workspaceFolders || []) {
			const found = await walkWorkspaces(expl.ws.fs, folder.uri);
			let needWorkspace = false;
			for (const [uri, isMod] of found.entries()) {
				if (!isMod) {
					needWorkspace = true;
					continue;
				}

				await getModule(expl, Uri.parse(uri));
			}

			// If the workspace folder contains any Go files not in a module, create a workspace entry
			if (needWorkspace) {
				await getWorkspace(expl, folder);
			}
		}
		return;
	}

	const uri = Uri.parse(item.id);

	// The user expanded a module or workspace - find all packages
	if (uri.query === 'module' || uri.query === 'workspace') {
		await walkPackages(expl.ws.fs, uri, async (uri) => {
			await getPackage(expl, uri);
		});
	}

	// The user expanded a module or package - find all files
	if (uri.query === 'module' || uri.query === 'package') {
		for (const [file, type] of await expl.ws.fs.readDirectory(uri)) {
			if (type !== FileType.File || !file.endsWith('_test.go')) {
				continue;
			}

			await getFile(expl, Uri.joinPath(uri, file));
		}
	}

	// The user expanded a file - find all functions
	if (uri.query === 'file') {
		const doc = await expl.ws.openTextDocument(uri.with({ query: '', fragment: '' }));
		await processDocument(expl, doc);
	}

	// TODO(firelizzard18): If uri.query is test or benchmark, this is where we
	// would discover sub tests or benchmarks, if that is feasible.
}

// Recursively find all tests, benchmarks, and examples within a
// module/package/etc, minus exclusions. Map tests to the package they are
// defined in, and track files.
async function collectTests(
	expl: TestExplorer,
	item: TestItem,
	excluded: TestItem[],
	functions: Map<string, TestItem[]>,
	docs: Set<Uri>
) {
	for (let i = item; i.parent; i = i.parent) {
		if (excluded.indexOf(i) >= 0) {
			return;
		}
	}

	const uri = Uri.parse(item.id);
	if (!uri.fragment) {
		if (!item.children.size) {
			await resolveChildren(expl, item);
		}

		const runBench = getGoConfig(item.uri).get('testExplorerRunBenchmarks');
		for (const child of item.children.values()) {
			const uri = Uri.parse(child.id);
			if (uri.query === 'benchmark' && !runBench) continue;
			await collectTests(expl, child, excluded, functions, docs);
		}
		return;
	}

	const file = uri.with({ query: '', fragment: '' });
	docs.add(file);

	const dir = file.with({ path: path.dirname(uri.path) }).toString();
	if (functions.has(dir)) {
		functions.get(dir).push(item);
	} else {
		functions.set(dir, [item]);
	}
	return;
}

// TestRunOutput is a fake OutputChannel that forwards all test output to the test API
// console.
class TestRunOutput<T> implements OutputChannel {
	readonly name: string;
	constructor(private run: TestRun<T>) {
		this.name = `Test run at ${new Date()}`;
	}

	append(value: string) {
		this.run.appendOutput(value);
	}

	appendLine(value: string) {
		this.run.appendOutput(value + '\r\n');
	}

	clear() {}
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	show(...args: unknown[]) {}
	hide() {}
	dispose() {}
}

// Resolve a test name to a test item. If the test name is TestXxx/Foo, Foo is
// created as a child of TestXxx. The same is true for TestXxx#Foo and
// TestXxx/#Foo.
function resolveTestName(expl: TestExplorer, tests: Record<string, TestItem>, name: string): TestItem | undefined {
	if (!name) {
		return;
	}

	const parts = name.split(/[#/]+/);
	let test = tests[parts[0]];
	if (!test) {
		return;
	}

	for (const part of parts.slice(1)) {
		test = getOrCreateSubTest(expl, test, part);
	}
	return test;
}

// Process benchmark events (see test_events.md)
function consumeGoBenchmarkEvent<T>(
	expl: TestExplorer,
	run: TestRun<T>,
	benchmarks: Record<string, TestItem>,
	complete: Set<TestItem>,
	e: GoTestOutput
) {
	if (e.Test) {
		// Find (or create) the (sub)benchmark
		const test = resolveTestName(expl, benchmarks, e.Test);
		if (!test) {
			return;
		}

		switch (e.Action) {
			case 'fail': // Failed
				run.setState(test, TestResultState.Failed);
				complete.add(test);
				break;

			case 'skip': // Skipped
				run.setState(test, TestResultState.Skipped);
				complete.add(test);
				break;
		}

		return;
	}

	// Ignore anything that's not an output event
	if (!e.Output) {
		return;
	}

	// On start:    "BenchmarkFooBar"
	// On complete: "BenchmarkFooBar-4    123456    123.4 ns/op    123 B/op    12 allocs/op"

	// Extract the benchmark name and status
	const m = e.Output.match(/^(?<name>Benchmark[/\w]+)(?:-(?<procs>\d+)\s+(?<result>.*))?(?:$|\n)/);
	if (!m) {
		// If the output doesn't start with `BenchmarkFooBar`, ignore it
		return;
	}

	// Find (or create) the (sub)benchmark
	const test = resolveTestName(expl, benchmarks, m.groups.name);
	if (!test) {
		return;
	}

	// If output includes benchmark results, the benchmark passed. If output
	// only includes the benchmark name, the benchmark is running.
	if (m.groups.result) {
		run.appendMessage(test, {
			message: m.groups.result,
			severity: TestMessageSeverity.Information,
			location: new Location(test.uri, test.range.start)
		});
		run.setState(test, TestResultState.Passed);
		complete.add(test);
	} else {
		run.setState(test, TestResultState.Running);
	}
}

// Pass any incomplete benchmarks (see test_events.md)
function passBenchmarks<T>(run: TestRun<T>, items: Record<string, TestItem>, complete: Set<TestItem>) {
	function pass(item: TestItem) {
		if (!complete.has(item)) {
			run.setState(item, TestResultState.Passed);
		}
		for (const child of item.children.values()) {
			pass(child);
		}
	}

	for (const name in items) {
		pass(items[name]);
	}
}

// Process test events (see test_events.md)
function consumeGoTestEvent<T>(
	expl: TestExplorer,
	run: TestRun<T>,
	tests: Record<string, TestItem>,
	record: Map<TestItem, string[]>,
	e: GoTestOutput
) {
	const test = resolveTestName(expl, tests, e.Test);
	if (!test) {
		return;
	}

	switch (e.Action) {
		case 'run':
			run.setState(test, TestResultState.Running);
			return;

		case 'pass':
			run.setState(test, TestResultState.Passed, e.Elapsed * 1000);
			return;

		case 'fail':
			run.setState(test, TestResultState.Failed, e.Elapsed * 1000);
			return;

		case 'skip':
			run.setState(test, TestResultState.Skipped);
			return;

		case 'output':
			if (/^(=== RUN|\s*--- (FAIL|PASS): )/.test(e.Output)) {
				return;
			}

			if (record.has(test)) record.get(test).push(e.Output);
			else record.set(test, [e.Output]);
			return;

		default:
			console.log(e);
			return;
	}
}

// Search recorded test output for `file.go:123: Foo bar` and attach a message
// to the corresponding location.
function processRecordedOutput<T>(run: TestRun<T>, test: TestItem, output: string[]) {
	// mostly copy and pasted from https://gitlab.com/firelizzard/vscode-go-test-adapter/-/blob/733443d229df68c90145a5ae7ed78ca64dec6f43/src/tests.ts
	type message = { all: string; error?: string };
	const parsed = new Map<string, message>();
	let current: message | undefined;

	for (const item of output) {
		const fileAndLine = item.match(/^\s*(?<file>.*\.go):(?<line>\d+): ?(?<message>.*\n)$/);
		if (fileAndLine) {
			current = { all: fileAndLine.groups.message };
			parsed.set(`${fileAndLine.groups.file}:${fileAndLine.groups.line}`, current);
			continue;
		}

		if (!current) continue;

		const entry = item.match(/^\s*(?:(?<name>[^:]+): *| +)\t(?<message>.*\n)$/);
		if (!entry) continue;

		current.all += entry.groups.message;
		if (entry.groups.name === 'Error') {
			current.error = entry.groups.message;
		} else if (!entry.groups.name && current.error) current.error += entry.groups.message;
	}

	const dir = Uri.joinPath(test.uri, '..');
	for (const [location, { all, error }] of parsed.entries()) {
		const hover = (error || all).trim();
		const message = hover.split('\n')[0].replace(/:\s+$/, '');

		const i = location.lastIndexOf(':');
		const file = location.substring(0, i);
		const line = Number(location.substring(i + 1)) - 1;

		run.appendMessage(test, {
			message,
			severity: error ? TestMessageSeverity.Error : TestMessageSeverity.Information,
			location: new Location(Uri.joinPath(dir, file), new Position(line, 0))
		});
	}
}

// Execute tests - TestController.runTest callback
async function runTest<T>(expl: TestExplorer, request: TestRunRequest<T>) {
	const collected = new Map<string, TestItem[]>();
	const docs = new Set<Uri>();
	for (const item of request.tests) {
		await collectTests(expl, item, request.exclude, collected, docs);
	}

	// Save all documents that contain a test we're about to run, to ensure `go
	// test` has the latest changes
	await Promise.all(
		Array.from(docs).map((uri) => {
			expl.ws.openTextDocument(uri).then((doc) => doc.save());
		})
	);

	const run = expl.ctrl.createTestRun(request);
	const outputChannel = new TestRunOutput(run);
	const goConfig = getGoConfig();
	for (const [dir, items] of collected.entries()) {
		const uri = Uri.parse(dir);
		const isMod = await isModSupported(uri, true);
		const flags = getTestFlags(goConfig);

		// Separate tests and benchmarks and mark them as queued for execution.
		// Clear any sub tests/benchmarks generated by a previous run.
		const tests: Record<string, TestItem> = {};
		const benchmarks: Record<string, TestItem> = {};
		for (const item of items) {
			run.setState(item, TestResultState.Queued);

			discardChildren(item);

			const uri = Uri.parse(item.id);
			if (uri.query === 'benchmark') {
				benchmarks[uri.fragment] = item;
			} else {
				tests[uri.fragment] = item;
			}
		}

		const record = new Map<TestItem, string[]>();
		const testFns = Object.keys(tests);
		const benchmarkFns = Object.keys(benchmarks);

		// Run tests
		if (testFns.length > 0) {
			await goTest({
				goConfig,
				flags,
				isMod,
				outputChannel,
				dir: uri.fsPath,
				functions: testFns,
				goTestOutputConsumer: (e) => consumeGoTestEvent(expl, run, tests, record, e)
			});
		}

		// Run benchmarks
		if (benchmarkFns.length > 0) {
			const complete = new Set<TestItem>();
			await goTest({
				goConfig,
				flags,
				isMod,
				outputChannel,
				dir: uri.fsPath,
				functions: benchmarkFns,
				isBenchmark: true,
				goTestOutputConsumer: (e) => consumeGoBenchmarkEvent(expl, run, benchmarks, complete, e)
			});

			// Explicitly pass any incomplete benchmarks (see test_events.md)
			passBenchmarks(run, benchmarks, complete);
		}

		// Create test messages
		for (const [test, output] of record.entries()) {
			processRecordedOutput(run, test, output);
		}
	}

	run.end();
}
