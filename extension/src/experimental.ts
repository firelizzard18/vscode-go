import { EventEmitter, ExtensionContext, ExtensionMode, extensions, workspace } from 'vscode';
import { extensionInfo } from './config';

type Settings = {
	testExplorer: boolean;
};

export const experiments = new (class Experiments {
	activate(ctx: ExtensionContext) {
		ctx.subscriptions.push(this.#didChange);

		// Don't enable any experiments in a production release
		if (ctx.extensionMode === ExtensionMode.Production && !extensionInfo.isPreview) {
			return;
		}

		// Check on boot
		this.#checkExtensions();

		// Check when an extension is installed or uninstalled
		ctx.subscriptions.push(extensions.onDidChange(() => this.#checkExtensions()));

		// Check when the configuration changes
		ctx.subscriptions.push(
			workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('go.experiments')) {
					this.#checkExtensions();
				}
			})
		);
	}

	#checkExtensions() {
		const settings = workspace.getConfiguration('go').get<Settings>('experiments');
		const goExp = extensions.getExtension('ethan-reesor.exp-vscode-go');

		// Check if the test explorer experiment should be activated
		const testExplorer = settings?.testExplorer !== false && !!goExp;
		if (testExplorer !== this.#testExplorer) {
			this.#testExplorer = testExplorer;
			this.#didChange.fire(this);
		}
	}

	#didChange = new EventEmitter<Experiments>();
	readonly onDidChange = this.#didChange.event;

	#testExplorer = false;
	get testExplorer() {
		return this.#testExplorer;
	}
})();
