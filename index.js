{
	const defined = [];
	const define = Object.assign(
		(...args) => {
			const constructor = args.pop();
			const [name, deps] =
				args.length === 2
					? args
					: Array.isArray(args[0])
						? [undefined, args[0]]
						: [args[0], undefined];

			const factory =
				constructor instanceof Function
					? constructor
					: () => constructor;

			let dependencies = deps || ['require', 'exports', 'module'];

			if (!deps) {
				[
					...factory
						.toString()
						.replace(/(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/gm, '') // Remove any comments first
						.matchAll(
							/(?: |^)\s*require\((?:"((?:\\"|[^"])*)"|'((?:\\'|[^'])*)')\)/g
						),
				].forEach(([, match1, match2]) => {
					const dep = match1 || match2;
					if (!dependencies.includes(dep)) {
						dependencies.push(dep);
					}
				});
			}

			defined.push({
				name,
				dependencies,
				factory,
			});
		},
		{
			amd: {
				baseUrl: './',
				config: {},
			},
		}
	);

	const memoPending = (fn) => {
		const cache = new Map();

		return Object.assign(
			(arg) => {
				if (!cache.has(arg)) {
					const promise = fn(arg);
					if (promise.finally) {
						promise.finally(() => {
							cache.delete(arg);
						});
					}
					cache.set(arg, promise);
				}

				return cache.get(arg);
			},
			{
				delete: (arg) => cache.delete(arg),
			}
		);
	};

	const normalize = (contextModule, module) => {
		if (module.startsWith('./') || module.startsWith('../')) {
			const baseContext = new URL('/', document.baseURI);
			const baseUrl = new URL(contextModule, baseContext);
			const moduleUrl = new URL(module, baseUrl).toString();
			if (!moduleUrl.startsWith(baseContext)) {
				throw new Error('Wrong module id');
			}
			return moduleUrl.replace(baseContext, '');
		}
		return module;
	};

	const loaded = new Map();
	const definitions = new Map();

	const loadDefinition = memoPending((moduleId) => {
		const src = require.toUrl(moduleId);
		let node;
		return new Promise((onload, onerror) => {
			node = document.head.appendChild(
				Object.assign(document.createElement('script'), {
					src,
					async: true,
					onload,
					onerror,
				})
			);
		})
			.then(() => {
				defined.forEach(({ name, ...rest }) => {
					const definedName = name ?? moduleId;
					if (definitions.has(definedName)) {
						return;
					}
					definitions.set(definedName, rest);
				});
				defined.length = 0;
			})
			.finally(() => {
				document.head.removeChild(node);
			});
	});

	const construct = memoPending((moduleId) => {
		const { dependencies, factory } = definitions.get(moduleId);

		const localNormalize = normalize.bind(undefined, moduleId);

		const module = {
			id: moduleId,
			exports: {},
			config: () => {
				if (!define.amd.config?.[moduleId]) {
					define.amd.config[moduleId] = {};
				}
				return define.amd.config[moduleId];
			},
		};

		const localRequire = getRequire(moduleId);

		const special = new Map([
			['require', localRequire],
			['module', module],
			['exports', module.exports], // ?
		]);

		const deps = dependencies.map((depName) => {
			return (
				special.get(depName) ||
				new Promise((resolve, reject) => {
					localRequire([depName], resolve, reject);
				})
			);
		});

		return Promise.all(deps).then((args) => {
			definitions.delete(moduleId);

			const exports = factory(...args.slice(0, factory.length));
			if (exports) {
				module.exports = exports;
			}

			return module.exports;
		});
	});

	const pending = new Map();
	const getRequire = (parentModuleId = '/') => {
		const localNormalize = normalize.bind(null, parentModuleId);

		const require = (...args) => {
			if (args.length === 1) {
				let pluginId = '';
				let plugin = defaultPlugin;
				let moduleId = args[0];

				const index = moduleId.indexOf('!');
				if (index !== -1) {
					pluginId = localNormalize(moduleId.slice(0, index));
					moduleId = moduleId.slice(index + 1);
					plugin = require(pluginId);
				}
				moduleId = plugin.normalize(moduleId, localNormalize);
				const key = `${pluginId}!${moduleId}`;

				if (!loaded.has(key)) {
					throw new Error(`${moduleId} has not been loaded.`);
				}
				return loaded.get(key);
			}

			const [deps, cb, onerror] = args;
			const dependencies = deps.map((dep) => {
				let resource = dep;
				let pluginId = '';
				let plugin = Promise.resolve(defaultPlugin);

				const index = resource.indexOf('!');
				if (index !== -1) {
					pluginId = localNormalize(resource.slice(0, index));
					resource = resource.slice(index + 1);

					plugin = new Promise((resolve, reject) => {
						require([pluginId], resolve, reject);
					});
				}

				return plugin
					.then(({ load, normalize = defaultPlugin.normalize }) => {
						const normalized = normalize(resource, localNormalize);
						const key = `${pluginId}!${normalized}`;

						if (!pending.has(key)) {
							const promise = new Promise((resolve, reject) => {
								const cb = resolve;
								cb.error = reject;
								load(normalized, require, cb);
							})
								.then((value) => {
									loaded.set(
										`${pluginId}!${normalized}`,
										value
									);
									return value;
								})
								.finally(() => {
									pending.delete(key);
								});

							pending.set(key, promise);
						}

						return pending.get(key);
					})
					.catch(onerror);
			});

			Promise.all(dependencies).then((args) => {
				cb(...args);
			});
		};

		require.toUrl = (path) => {
			const { baseUrl } = define.amd;
			const baseContext = new URL(baseUrl, document.baseURI);
			const match = path.match(/(\.\w+)$/);
			const [, extension = '.js'] = match || [];
			let module = localNormalize(path.substring(0, match?.index));
			const [prefix, replace] =
				Object.entries(define.amd.paths || {})
					.sort(([a, b]) => b.split('/').length - a.split('/').length)
					.find(([key]) => {
						return module === key || module.startsWith(`${key}/`);
					}) || [];
			if (prefix) {
				module = module.replace(prefix, replace);
			}
			let url = `${new URL(module, baseContext)}${extension}`;
			if (url.startsWith(document.baseURI)) {
				url = url.replace(document.baseURI, '');
			}
			return url;
		};

		return require;
	};

	const defaultPlugin = {
		load(name, req, load) {
			if (name === 'require') {
				load(req);
				return;
			}
			if (loaded.has(name)) {
				load(loaded.get(name));
				return;
			}

			(definitions.has(name) ? Promise.resolve() : loadDefinition(name))
				.then(() => load(construct(name)))
				.catch(load.error);
		},
		normalize(name, normalize) {
			return normalize(name);
		},
	};

	window.define = define;
	window.require = getRequire();
}
