import { Parser } from 'acorn';
import MagicString from 'magic-string';

const rewritePattern = require('regexpu-core');

// used for debugging, without the noise created by
// circular references
function toJSON(node) {
	var obj = {};

	Object.keys(node).forEach(key => {
		if (
			key === 'parent' ||
			key === 'program' ||
			key === 'keys' ||
			key === '__wrapped'
		)
			{ return; }

		if (Array.isArray(node[key])) {
			obj[key] = node[key].map(toJSON);
		} else if (node[key] && node[key].toJSON) {
			obj[key] = node[key].toJSON();
		} else {
			obj[key] = node[key];
		}
	});

	return obj;
}

class Node {
	ancestor(level) {
		var node = this;
		while (level--) {
			node = node.parent;
			if (!node) { return null; }
		}

		return node;
	}

	contains(node) {
		while (node) {
			if (node === this) { return true; }
			node = node.parent;
		}

		return false;
	}

	findLexicalBoundary() {
		return this.parent.findLexicalBoundary();
	}

	findNearest(type) {
		if (typeof type === 'string') { type = new RegExp(`^${type}$`); }
		if (type.test(this.type)) { return this; }
		return this.parent.findNearest(type);
	}

	unparenthesizedParent() {
		var node = this.parent;
		while (node && node.type === 'ParenthesizedExpression') {
			node = node.parent;
		}
		return node;
	}

	unparenthesize() {
		var node = this;
		while (node.type === 'ParenthesizedExpression') {
			node = node.expression;
		}
		return node;
	}

	findScope(functionScope) {
		return this.parent.findScope(functionScope);
	}

	getIndentation() {
		return this.parent.getIndentation();
	}

	initialise(transforms) {
		for (var i = 0, list = this.keys; i < list.length; i += 1) {
			var key = list[i];

			var value = this[key];

			if (Array.isArray(value)) {
				value.forEach(node => node && node.initialise(transforms));
			} else if (value && typeof value === 'object') {
				value.initialise(transforms);
			}
		}
	}

	toJSON() {
		return toJSON(this);
	}

	toString() {
		return this.program.magicString.original.slice(this.start, this.end);
	}

	transpile(code, transforms) {
		for (var i = 0, list = this.keys; i < list.length; i += 1) {
			var key = list[i];

			var value = this[key];

			if (Array.isArray(value)) {
				value.forEach(node => node && node.transpile(code, transforms));
			} else if (value && typeof value === 'object') {
				value.transpile(code, transforms);
			}
		}
	}
}

function extractNames(node) {
	var names = [];
	extractors[node.type](names, node);
	return names;
}

var extractors = {
	Identifier(names, node) {
		names.push(node);
	},

	ObjectPattern(names, node) {
		for (var i = 0, list = node.properties; i < list.length; i += 1) {
			var prop = list[i];

			extractors[prop.type](names, prop);
		}
	},

	Property(names, node) {
		extractors[node.value.type](names, node.value);
	},

	ArrayPattern(names, node) {
		for (var i = 0, list = node.elements; i < list.length; i += 1) {
			var element = list[i];

			if (element) { extractors[element.type](names, element); }
		}
	},

	RestElement(names, node) {
		extractors[node.argument.type](names, node.argument);
	},

	AssignmentPattern(names, node) {
		extractors[node.left.type](names, node.left);
	}
};

var reserved = Object.create(null);
'do if in for let new try var case else enum eval null this true void with await break catch class const false super throw while yield delete export import public return static switch typeof default extends finally package private continue debugger function arguments interface protected implements instanceof'
	.split(' ')
	.forEach(word => (reserved[word] = true));

function Scope(options) {
	options = options || {};

	this.parent = options.parent;
	this.isBlockScope = !!options.block;
	this.createDeclarationCallback = options.declare;

	var scope = this;
	while (scope.isBlockScope) { scope = scope.parent; }
	this.functionScope = scope;

	this.identifiers = [];
	this.declarations = Object.create(null);
	this.references = Object.create(null);
	this.blockScopedDeclarations = this.isBlockScope ? null : Object.create(null);
	this.aliases = Object.create(null);
}

Scope.prototype = {
	addDeclaration(node, kind) {
		for (var i = 0, list = extractNames(node); i < list.length; i += 1) {
			var identifier = list[i];

			var name = identifier.name;

			var declaration = { name, node: identifier, kind, instances: [] };
			this.declarations[name] = declaration;

			if (this.isBlockScope) {
				if (!this.functionScope.blockScopedDeclarations[name])
					{ this.functionScope.blockScopedDeclarations[name] = []; }
				this.functionScope.blockScopedDeclarations[name].push(declaration);
			}
		}
	},

	addReference(identifier) {
		if (this.consolidated) {
			this.consolidateReference(identifier);
		} else {
			this.identifiers.push(identifier);
		}
	},

	consolidate() {
		for (var i = 0; i < this.identifiers.length; i += 1) {
			// we might push to the array during consolidation, so don't cache length
			var identifier = this.identifiers[i];
			this.consolidateReference(identifier);
		}

		this.consolidated = true; // TODO understand why this is necessary... seems bad
	},

	consolidateReference(identifier) {
		var declaration = this.declarations[identifier.name];
		if (declaration) {
			declaration.instances.push(identifier);
		} else {
			this.references[identifier.name] = true;
			if (this.parent) { this.parent.addReference(identifier); }
		}
	},

	contains(name) {
		return (
			this.declarations[name] ||
			(this.parent ? this.parent.contains(name) : false)
		);
	},

	createIdentifier(base) {
		if (typeof base === 'number') { base = base.toString(); }

		base = base
			.replace(/\s/g, '')
			.replace(/\[([^\]]+)\]/g, '_$1')
			.replace(/[^a-zA-Z0-9_$]/g, '_')
			.replace(/_{2,}/, '_');

		var name = base;
		var counter = 1;

		while (
			this.declarations[name] ||
			this.references[name] ||
			this.aliases[name] ||
			name in reserved
		) {
			name = `${base}$${counter++}`;
		}

		this.aliases[name] = true;
		return name;
	},

	createDeclaration(base) {
		var id = this.createIdentifier(base);
		this.createDeclarationCallback(id);
		return id;
	},

	findDeclaration(name) {
		return (
			this.declarations[name] ||
			(this.parent && this.parent.findDeclaration(name))
		);
	},

	// Sometimes, block scope declarations change name during transpilation
	resolveName(name) {
		var declaration = this.findDeclaration(name);
		return declaration ? declaration.name : name;
	}
};

function locate(source, index) {
	var lines = source.split('\n');
	var len = lines.length;

	var lineStart = 0;
	var i;

	for (i = 0; i < len; i += 1) {
		var line = lines[i];
		var lineEnd = lineStart + line.length + 1; // +1 for newline

		if (lineEnd > index) {
			return { line: i + 1, column: index - lineStart, char: i };
		}

		lineStart = lineEnd;
	}

	throw new Error('Could not determine location of character');
}

function pad(num, len) {
	var result = String(num);
	return result + repeat(' ', len - result.length);
}

function repeat(str, times) {
	var result = '';
	while (times--) { result += str; }
	return result;
}

function getSnippet(source, loc, length) {
	if ( length === void 0 ) length = 1;

	var first = Math.max(loc.line - 5, 0);
	var last = loc.line;

	var numDigits = String(last).length;

	var lines = source.split('\n').slice(first, last);

	var lastLine = lines[lines.length - 1];
	var offset = lastLine.slice(0, loc.column).replace(/\t/g, '  ').length;

	var snippet = lines
		.map((line, i) => `${pad(i + first + 1, numDigits)} : ${line.replace(/\t/g, '  ')}`)
		.join('\n');

	snippet += '\n' + repeat(' ', numDigits + 3 + offset) + repeat('^', length);

	return snippet;
}

class CompileError extends Error {
	constructor(message, node) {
		super(message);

		this.name = 'CompileError';
		if (!node) {
			return;
		}

		var source = node.program.magicString.original;
		var loc = locate(source, node.start);

		this.message = message + ` (${loc.line}:${loc.column})`;

		this.stack = new Error().stack.replace(
			new RegExp(`.+new ${this.name}.+\\n`, 'm'),
			''
		);

		this.loc = loc;
		this.snippet = getSnippet(source, loc, node.end - node.start);
	}

	toString() {
		return `${this.name}: ${this.message}\n${this.snippet}`;
	}

	static missingTransform(feature, transformKey, node, dangerousKey) {
		if ( dangerousKey === void 0 ) dangerousKey = null;

		var maybeDangerous = dangerousKey ? `, or \`transforms: { ${dangerousKey}: true }\` if you know what you're doing` : '';
		throw new CompileError(`Transforming ${feature} is not ${dangerousKey ? "fully supported" : "implemented"}. Use \`transforms: { ${transformKey}: false }\` to skip transformation and disable this error${maybeDangerous}.`, node);
	}
}

function findIndex(array, fn) {
	for (var i = 0; i < array.length; i += 1) {
		if (fn(array[i], i)) { return i; }
	}

	return -1;
}

var handlers = {
	Identifier: destructureIdentifier,
	AssignmentPattern: destructureAssignmentPattern,
	ArrayPattern: destructureArrayPattern,
	ObjectPattern: destructureObjectPattern
};

function destructure(
	code,
	createIdentifier,
	resolveName,
	node,
	ref,
	inline,
	statementGenerators
) {
	handlers[node.type](code, createIdentifier, resolveName, node, ref, inline, statementGenerators);
}

function destructureIdentifier(
	code,
	createIdentifier,
	resolveName,
	node,
	ref,
	inline,
	statementGenerators
) {
	statementGenerators.push((start, prefix, suffix) => {
		code.overwrite(node.start, node.end, (inline ? prefix : `${prefix}var `) + resolveName(node) + ` = ${ref}${suffix}`);
		code.move(node.start, node.end, start);
	});
}

function destructureMemberExpression(
	code,
	createIdentifier,
	resolveName,
	node,
	ref,
	inline,
	statementGenerators
) {
	statementGenerators.push((start, prefix, suffix) => {
		code.prependRight(node.start, inline ? prefix : `${prefix}var `);
		code.appendLeft(node.end, ` = ${ref}${suffix}`);
		code.move(node.start, node.end, start);
	});
}

function destructureAssignmentPattern(
	code,
	createIdentifier,
	resolveName,
	node,
	ref,
	inline,
	statementGenerators
) {
	var isIdentifier = node.left.type === 'Identifier';
	var name = isIdentifier ? node.left.name : ref;

	if (!inline) {
		statementGenerators.push((start, prefix, suffix) => {
			code.prependRight(
				node.left.end,
				`${prefix}if ( ${name} === void 0 ) ${name}`
			);
			code.move(node.left.end, node.right.end, start);
			code.appendLeft(node.right.end, suffix);
		});
	}

	if (!isIdentifier) {
		destructure(code, createIdentifier, resolveName, node.left, ref, inline, statementGenerators);
	}
}

function destructureArrayPattern(
	code,
	createIdentifier,
	resolveName,
	node,
	ref,
	inline,
	statementGenerators
) {
	var c = node.start;

	node.elements.forEach((element, i) => {
		if (!element) { return; }

		if (element.type === 'RestElement') {
			handleProperty(
				code,
				createIdentifier,
				resolveName,
				c,
				element.argument,
				`${ref}.slice(${i})`,
				inline,
				statementGenerators
			);
		} else {
			handleProperty(
				code,
				createIdentifier,
				resolveName,
				c,
				element,
				`${ref}[${i}]`,
				inline,
				statementGenerators
			);
		}
		c = element.end;
	});

	code.remove(c, node.end);
}

function destructureObjectPattern(
	code,
	createIdentifier,
	resolveName,
	node,
	ref,
	inline,
	statementGenerators
) {
	var c = node.start;

	var nonRestKeys = [];
	node.properties.forEach(prop => {
		var value;
		var content;
		if (prop.type === 'Property') {
			content = prop.value;
			if (!prop.computed && prop.key.type === 'Identifier') {
				value = `${ref}.${prop.key.name}`;
				nonRestKeys.push(`"${prop.key.name}"`);
			} else if (!prop.computed && prop.key.type === 'Literal') {
				value = `${ref}[${prop.key.raw}]`;
				nonRestKeys.push(JSON.stringify(String(prop.key.value)));
			} else {
				var expr = code.slice(prop.key.start, prop.key.end);
				value = `${ref}[${expr}]`;
				nonRestKeys.push(`String(${expr})`);
			}
		} else if (prop.type === 'RestElement') {
			content = prop.argument;
			value = createIdentifier('rest');
			statementGenerators.push((start, prefix, suffix) => {
				var helper = prop.program.getObjectWithoutPropertiesHelper(code);
				code.overwrite(
					prop.start,
					(c = prop.argument.start),
					(inline ? prefix : `${prefix}var `) + `${value} = ${helper}( ${ref}, [${nonRestKeys.join(', ')}] )${suffix}`
				);
				code.move(prop.start, c, start);
			});
		} else {
			throw new CompileError(
				this,
				`Unexpected node of type ${prop.type} in object pattern`
			);
		}
		handleProperty(code, createIdentifier, resolveName, c, content, value, inline, statementGenerators);
		c = prop.end;
	});

	code.remove(c, node.end);
}

function handleProperty(
	code,
	createIdentifier,
	resolveName,
	c,
	node,
	value,
	inline,
	statementGenerators
) {
	switch (node.type) {
		case 'Identifier': {
			code.remove(c, node.start);
			destructureIdentifier(
				code,
				createIdentifier,
				resolveName,
				node,
				value,
				inline,
				statementGenerators
			);
			break;
		}

		case 'MemberExpression':
			code.remove(c, node.start);
			destructureMemberExpression(
				code,
				createIdentifier,
				resolveName,
				node,
				value,
				true,
				statementGenerators
			);
			break;

		case 'AssignmentPattern': {
			var name;

			var isIdentifier = node.left.type === 'Identifier';

			if (isIdentifier) {
				name = resolveName(node.left);
			} else {
				name = createIdentifier(value);
			}

			statementGenerators.push((start, prefix, suffix) => {
				if (inline) {
					code.prependRight(
						node.right.start,
						`${name} = ${value}, ${name} = ${name} === void 0 ? `
					);
					code.appendLeft(node.right.end, ` : ${name}${suffix}`);
				} else {
					code.prependRight(
						node.right.start,
						`${prefix}var ${name} = ${value}; if ( ${name} === void 0 ) ${name} = `
					);
					code.appendLeft(node.right.end, suffix);
				}

				code.move(node.right.start, node.right.end, start);
			});

			if (isIdentifier) {
				code.remove(c, node.right.start);
			} else {
				code.remove(c, node.left.start);
				code.remove(node.left.end, node.right.start);
				handleProperty(
					code,
					createIdentifier,
					resolveName,
					c,
					node.left,
					name,
					inline,
					statementGenerators
				);
			}

			break;
		}

		case 'ObjectPattern': {
			code.remove(c, (c = node.start));

			var ref = value;
			if (node.properties.length > 1) {
				ref = createIdentifier(value);

				statementGenerators.push((start, prefix, suffix) => {
					// this feels a tiny bit hacky, but we can't do a
					// straightforward appendLeft and keep correct order...
					code.prependRight(node.start, (inline ? '' : `${prefix}var `) + `${ref} = `);
					code.overwrite(node.start, (c = node.start + 1), value);
					code.appendLeft(c, suffix);

					code.overwrite(
						node.start,
						(c = node.start + 1),
						(inline ? '' : `${prefix}var `) + `${ref} = ${value}${suffix}`
					);
					code.move(node.start, c, start);
				});
			}

			destructureObjectPattern(
				code,
				createIdentifier,
				resolveName,
				node,
				ref,
				inline,
				statementGenerators
			);

			break;
		}

		case 'ArrayPattern': {
			code.remove(c, (c = node.start));

			if (node.elements.filter(Boolean).length > 1) {
				var ref$1 = createIdentifier(value);

				statementGenerators.push((start, prefix, suffix) => {
					code.prependRight(node.start, (inline ? '' : `${prefix}var `) + `${ref$1} = `);
					code.overwrite(node.start, (c = node.start + 1), value, {
						contentOnly: true
					});
					code.appendLeft(c, suffix);

					code.move(node.start, c, start);
				});

				node.elements.forEach((element, i) => {
					if (!element) { return; }

					if (element.type === 'RestElement') {
						handleProperty(
							code,
							createIdentifier,
							resolveName,
							c,
							element.argument,
							`${ref$1}.slice(${i})`,
							inline,
							statementGenerators
						);
					} else {
						handleProperty(
							code,
							createIdentifier,
							resolveName,
							c,
							element,
							`${ref$1}[${i}]`,
							inline,
							statementGenerators
						);
					}
					c = element.end;
				});
			} else {
				var index = findIndex(node.elements, Boolean);
				var element = node.elements[index];
				if (element.type === 'RestElement') {
					handleProperty(
						code,
						createIdentifier,
						resolveName,
						c,
						element.argument,
						`${value}.slice(${index})`,
						inline,
						statementGenerators
					);
				} else {
					handleProperty(
						code,
						createIdentifier,
						resolveName,
						c,
						element,
						`${value}[${index}]`,
						inline,
						statementGenerators
					);
				}
				c = element.end;
			}

			code.remove(c, node.end);
			break;
		}

		default: {
			throw new Error(`Unexpected node type in destructuring (${node.type})`);
		}
	}
}

function isUseStrict(node) {
	if (!node) { return false; }
	if (node.type !== 'ExpressionStatement') { return false; }
	if (node.expression.type !== 'Literal') { return false; }
	return node.expression.value === 'use strict';
}

class BlockStatement extends Node {
	createScope() {
		this.parentIsFunction = /Function/.test(this.parent.type);
		this.isFunctionBlock = this.parentIsFunction || this.parent.type === 'Root';
		this.scope = new Scope({
			block: !this.isFunctionBlock,
			parent: this.parent.findScope(false),
			declare: id => this.createdDeclarations.push(id)
		});

		if (this.parentIsFunction) {
			this.parent.params.forEach(node => {
				this.scope.addDeclaration(node, 'param');
			});
		}
	}

	initialise(transforms) {
		this.thisAlias = null;
		this.argumentsAlias = null;
		this.defaultParameters = [];
		this.createdDeclarations = [];

		// normally the scope gets created here, during initialisation,
		// but in some cases (e.g. `for` statements), we need to create
		// the scope early, as it pertains to both the init block and
		// the body of the statement
		if (!this.scope) { this.createScope(); }

		this.body.forEach(node => node.initialise(transforms));

		this.scope.consolidate();
	}

	findLexicalBoundary() {
		if (this.type === 'Program') { return this; }
		if (/^Function/.test(this.parent.type)) { return this; }

		return this.parent.findLexicalBoundary();
	}

	findScope(functionScope) {
		if (functionScope && !this.isFunctionBlock)
			{ return this.parent.findScope(functionScope); }
		return this.scope;
	}

	getArgumentsAlias() {
		if (!this.argumentsAlias) {
			this.argumentsAlias = this.scope.createIdentifier('arguments');
		}

		return this.argumentsAlias;
	}

	getArgumentsArrayAlias() {
		if (!this.argumentsArrayAlias) {
			this.argumentsArrayAlias = this.scope.createIdentifier('argsArray');
		}

		return this.argumentsArrayAlias;
	}

	getThisAlias() {
		if (!this.thisAlias) {
			this.thisAlias = this.scope.createIdentifier('this');
		}

		return this.thisAlias;
	}

	getIndentation() {
		if (this.indentation === undefined) {
			var source = this.program.magicString.original;

			var useOuter = this.synthetic || !this.body.length;
			var c = useOuter ? this.start : this.body[0].start;

			while (c && source[c] !== '\n') { c -= 1; }

			this.indentation = '';

			// eslint-disable-next-line no-constant-condition
			while (true) {
				c += 1;
				var char = source[c];

				if (char !== ' ' && char !== '\t') { break; }

				this.indentation += char;
			}

			var indentString = this.program.magicString.getIndentString();

			// account for dedented class constructors
			var parent = this.parent;
			while (parent) {
				if (parent.kind === 'constructor' && !parent.parent.parent.superClass) {
					this.indentation = this.indentation.replace(indentString, '');
				}

				parent = parent.parent;
			}

			if (useOuter) { this.indentation += indentString; }
		}

		return this.indentation;
	}

	transpile(code, transforms) {
		var indentation = this.getIndentation();

		var introStatementGenerators = [];

		if (this.argumentsAlias) {
			introStatementGenerators.push((start, prefix, suffix) => {
				var assignment = `${prefix}var ${this.argumentsAlias} = arguments${
					suffix
				}`;
				code.appendLeft(start, assignment);
			});
		}

		if (this.thisAlias) {
			introStatementGenerators.push((start, prefix, suffix) => {
				var assignment = `${prefix}var ${this.thisAlias} = this${suffix}`;
				code.appendLeft(start, assignment);
			});
		}

		if (this.argumentsArrayAlias) {
			introStatementGenerators.push((start, prefix, suffix) => {
				var i = this.scope.createIdentifier('i');
				var assignment = `${prefix}var ${i} = arguments.length, ${
					this.argumentsArrayAlias
				} = Array(${i});\n${indentation}while ( ${i}-- ) ${
					this.argumentsArrayAlias
				}[${i}] = arguments[${i}]${suffix}`;
				code.appendLeft(start, assignment);
			});
		}

		if (/Function/.test(this.parent.type)) {
			this.transpileParameters(
				this.parent.params,
				code,
				transforms,
				indentation,
				introStatementGenerators
			);
		} else if ('CatchClause' === this.parent.type) {
			this.transpileParameters(
				[this.parent.param],
				code,
				transforms,
				indentation,
				introStatementGenerators
			);
		}

		if (transforms.letConst && this.isFunctionBlock) {
			this.transpileBlockScopedIdentifiers(code);
		}

		super.transpile(code, transforms);

		if (this.createdDeclarations.length) {
			introStatementGenerators.push((start, prefix, suffix) => {
				var assignment = `${prefix}var ${this.createdDeclarations.join(', ')}${suffix}`;
				code.appendLeft(start, assignment);
			});
		}

		if (this.synthetic) {
			if (this.parent.type === 'ArrowFunctionExpression') {
				var expr = this.body[0];

				if (introStatementGenerators.length) {
					code
						.appendLeft(this.start, `{`)
						.prependRight(this.end, `${this.parent.getIndentation()}}`);

					code.prependRight(expr.start, `\n${indentation}return `);
					code.appendLeft(expr.end, `;\n`);
				} else if (transforms.arrow) {
					code.prependRight(expr.start, `{ return `);
					code.appendLeft(expr.end, `; }`);
				}
			} else if (introStatementGenerators.length) {
				code.prependRight(this.start, `{`).appendLeft(this.end, `}`);
			}
		}

		var start;
		if (isUseStrict(this.body[0])) {
			start = this.body[0].end;
		} else if (this.synthetic || this.parent.type === 'Root') {
			start = this.start;
		} else {
			start = this.start + 1;
		}

		var prefix = `\n${indentation}`;
		var suffix = ';';
		introStatementGenerators.forEach((fn, i) => {
			if (i === introStatementGenerators.length - 1) { suffix = `;\n`; }
			fn(start, prefix, suffix);
		});
	}

	transpileParameters(params, code, transforms, indentation, introStatementGenerators) {
		params.forEach(param => {
			if (
				param.type === 'AssignmentPattern' &&
				param.left.type === 'Identifier'
			) {
				if (transforms.defaultParameter) {
					introStatementGenerators.push((start, prefix, suffix) => {
						var lhs = `${prefix}if ( ${param.left.name} === void 0 ) ${
							param.left.name
						}`;

						code
							.prependRight(param.left.end, lhs)
							.move(param.left.end, param.right.end, start)
							.appendLeft(param.right.end, suffix);
					});
				}
			} else if (param.type === 'RestElement') {
				if (transforms.spreadRest) {
					introStatementGenerators.push((start, prefix, suffix) => {
						var penultimateParam = params[params.length - 2];

						if (penultimateParam) {
							code.remove(
								penultimateParam ? penultimateParam.end : param.start,
								param.end
							);
						} else {
							var start$1 = param.start,
								end = param.end; // TODO https://gitlab.com/Rich-Harris/buble/issues/8

							while (/\s/.test(code.original[start$1 - 1])) { start$1 -= 1; }
							while (/\s/.test(code.original[end])) { end += 1; }

							code.remove(start$1, end);
						}

						var name = param.argument.name;
						var len = this.scope.createIdentifier('len');
						var count = params.length - 1;

						if (count) {
							code.prependRight(
								start,
								`${prefix}var ${name} = [], ${len} = arguments.length - ${
									count
								};\n${indentation}while ( ${len}-- > 0 ) ${name}[ ${
									len
								} ] = arguments[ ${len} + ${count} ]${suffix}`
							);
						} else {
							code.prependRight(
								start,
								`${prefix}var ${name} = [], ${len} = arguments.length;\n${
									indentation
								}while ( ${len}-- ) ${name}[ ${len} ] = arguments[ ${len} ]${
									suffix
								}`
							);
						}
					});
				}
			} else if (param.type !== 'Identifier') {
				if (transforms.parameterDestructuring) {
					var ref = this.scope.createIdentifier('ref');
					destructure(
						code,
						id => this.scope.createIdentifier(id),
						(ref) => {
							var name = ref.name;

							return this.scope.resolveName(name);
					},
						param,
						ref,
						false,
						introStatementGenerators
					);
					code.prependRight(param.start, ref);
				}
			}
		});
	}

	transpileBlockScopedIdentifiers(code) {
		Object.keys(this.scope.blockScopedDeclarations).forEach(name => {
			var declarations = this.scope.blockScopedDeclarations[name];

			for (var i$2 = 0, list$2 = declarations; i$2 < list$2.length; i$2 += 1) {
				var declaration = list$2[i$2];

				var cont = false; // TODO implement proper continue...

				if (declaration.kind === 'for.let') {
					// special case
					var forStatement = declaration.node.findNearest('ForStatement');

					if (forStatement.shouldRewriteAsFunction) {
						var outerAlias = this.scope.createIdentifier(name);
						var innerAlias = forStatement.reassigned[name]
							? this.scope.createIdentifier(name)
							: name;

						declaration.name = outerAlias;
						code.overwrite(
							declaration.node.start,
							declaration.node.end,
							outerAlias,
							{ storeName: true }
						);

						forStatement.aliases[name] = {
							outer: outerAlias,
							inner: innerAlias
						};

						for (var i = 0, list = declaration.instances; i < list.length; i += 1) {
							var identifier = list[i];

							var alias = forStatement.body.contains(identifier)
								? innerAlias
								: outerAlias;

							if (name !== alias) {
								code.overwrite(identifier.start, identifier.end, alias, {
									storeName: true
								});
							}
						}

						cont = true;
					}
				}

				if (!cont) {
					var alias$1 = this.scope.createIdentifier(name);

					if (name !== alias$1) {
						var declarationParent = declaration.node.parent;
						declaration.name = alias$1;
						code.overwrite(
							declaration.node.start,
							declaration.node.end,
							alias$1,
							{ storeName: true }
						);
						if (declarationParent.type === 'Property' && declarationParent.shorthand) {
							declarationParent.shorthand = false;
							code.prependLeft(declaration.node.start, `${name}: `);
						}

						for (var i$1 = 0, list$1 = declaration.instances; i$1 < list$1.length; i$1 += 1) {
							var identifier$1 = list$1[i$1];

							identifier$1.rewritten = true;
							var identifierParent = identifier$1.parent;
							code.overwrite(identifier$1.start, identifier$1.end, alias$1, {
								storeName: true
							});
							if (identifierParent.type === 'Property' && identifierParent.shorthand) {
								identifierParent.shorthand = false;
								code.prependLeft(identifier$1.start, `${name}: `);
							}
						}
					}
				}
			}
		});
	}
}

function isArguments(node) {
	return node.type === 'Identifier' && node.name === 'arguments';
}

function inlineSpreads(
	code,
	node,
	elements
) {
	var i = elements.length;

	while (i--) {
		var element = elements[i];
		if (!element || element.type !== 'SpreadElement') {
			continue;
		}
		var argument = element.argument;
		if (argument.type !== 'ArrayExpression') {
			continue;
		}
		var subelements = argument.elements;
		if (subelements.some(subelement => subelement === null)) {
			// Not even going to try inlining spread arrays with holes.
			// It's a lot of work (got to be VERY careful in comma counting for
			// ArrayExpression, and turn blanks into undefined for
			// CallExpression and NewExpression), and probably literally no one
			// would ever benefit from it.
			continue;
		}
		// We can inline it: drop the `...[` and `]` and sort out any commas.
		var isLast = i === elements.length - 1;
		if (subelements.length === 0) {
			code.remove(
				isLast && i !== 0
					? elements[i - 1].end  // Take the previous comma too
					: element.start,
				isLast
					? node.end - 1  // Must remove trailing comma; element.end wouldn???t
					: elements[i + 1].start);
		} else {
			// Strip the `...[` and the `]` with a possible trailing comma before it,
			// leaving just the possible trailing comma after it.
			code.remove(element.start, subelements[0].start);
			code.remove(
				// Strip a possible trailing comma after the last element
				subelements[subelements.length - 1].end,
				// And also a possible trailing comma after the spread
				isLast
					? node.end - 1
					: element.end
			);
		}
		elements.splice.apply(elements, [ i, 1 ].concat( subelements ));
		i += subelements.length;
	}
}

// Returns false if it???s safe to simply append a method call to the node,
// e.g. `a` ??? `a.concat()`.
//
// Returns true if it may not be and so parentheses should be employed,
// e.g. `a ? b : c` ??? `a ? b : c.concat()` would be wrong.
//
// This test may be overcautious; if desired it can be refined over time.
function needsParentheses(node) {
	switch (node.type) {
		// Currently whitelisted are all relevant ES5 node types ('Literal' and
		// 'ObjectExpression' are skipped as irrelevant for array/call spread.)
		case 'ArrayExpression':
		case 'CallExpression':
		case 'Identifier':
		case 'ParenthesizedExpression':
		case 'ThisExpression':
			return false;
		default:
			return true;
	}
}

function spread(
	code,
	elements,
	start,
	argumentsArrayAlias,
	isNew
) {
	var i = elements.length;
	var firstSpreadIndex = -1;

	while (i--) {
		var element$1 = elements[i];
		if (element$1 && element$1.type === 'SpreadElement') {
			if (isArguments(element$1.argument)) {
				code.overwrite(
					element$1.argument.start,
					element$1.argument.end,
					argumentsArrayAlias
				);
			}

			firstSpreadIndex = i;
		}
	}

	if (firstSpreadIndex === -1) { return false; } // false indicates no spread elements

	if (isNew) {
		for (i = 0; i < elements.length; i += 1) {
			var element$2 = elements[i];
			if (element$2.type === 'SpreadElement') {
				code.remove(element$2.start, element$2.argument.start);
			} else {
				code.prependRight(element$2.start, '[');
				code.prependRight(element$2.end, ']');
			}
		}

		return true; // true indicates some spread elements
	}

	var element = elements[firstSpreadIndex];
	var previousElement = elements[firstSpreadIndex - 1];

	if (!previousElement) {
		// We may need to parenthesize it to handle ternaries like [...a ? b : c].
		var addClosingParen;
		if (start !== element.start) {
			if ((addClosingParen = needsParentheses(element.argument))) {
				code.overwrite(start, element.start, '( ');
			} else {
				code.remove(start, element.start);
			}
		} else if (element.parent.type === 'CallExpression') {
			// CallExpression inserts `( ` itself, we add the ).
			// (Yeah, CallExpression did the needsParentheses call already,
			// but we don???t have its result handy, so do it again. It???s cheap.)
			addClosingParen = needsParentheses(element.argument);
		} else {
			// Should be unreachable, but doing this is more robust.
			throw new CompileError(
				'Unsupported spread construct, please raise an issue at https://github.com/bublejs/buble/issues',
				element
			);
		}
		code.overwrite(element.end, elements[1].start,
			addClosingParen ? ' ).concat( ' : '.concat( ');
	} else {
		code.overwrite(previousElement.end, element.start, ' ].concat( ');
	}

	for (i = firstSpreadIndex; i < elements.length; i += 1) {
		element = elements[i];

		if (element) {
			if (element.type === 'SpreadElement') {
				code.remove(element.start, element.argument.start);
			} else {
				code.appendLeft(element.start, '[');
				code.appendLeft(element.end, ']');
			}
		}
	}

	return true; // true indicates some spread elements
}

class ArrayExpression extends Node {
	initialise(transforms) {
		if (transforms.spreadRest && this.elements.length) {
			var lexicalBoundary = this.findLexicalBoundary();

			var i = this.elements.length;
			while (i--) {
				var element = this.elements[i];
				if (
					element &&
					element.type === 'SpreadElement' &&
					isArguments(element.argument)
				) {
					this.argumentsArrayAlias = lexicalBoundary.getArgumentsArrayAlias();
				}
			}
		}

		super.initialise(transforms);
	}

	transpile(code, transforms) {
		super.transpile(code, transforms);

		if (transforms.spreadRest) {
			inlineSpreads(code, this, this.elements);
			// erase trailing comma after last array element if not an array hole
			if (this.elements.length) {
				var lastElement = this.elements[this.elements.length - 1];
				if (
					lastElement &&
					/\s*,/.test(code.original.slice(lastElement.end, this.end))
				) {
					code.overwrite(lastElement.end, this.end - 1, ' ');
				}
			}

			if (this.elements.length === 1) {
				var element = this.elements[0];

				if (element && element.type === 'SpreadElement') {
					// special case ??? [ ...arguments ]
					if (isArguments(element.argument)) {
						code.overwrite(
							this.start,
							this.end,
							`[].concat( ${this.argumentsArrayAlias} )`
						); // TODO if this is the only use of argsArray, don't bother concating
					} else {
						code.overwrite(this.start, element.argument.start, '[].concat( ');
						code.overwrite(element.end, this.end, ' )');
					}
				}
			} else {
				var hasSpreadElements = spread(
					code,
					this.elements,
					this.start,
					this.argumentsArrayAlias
				);

				if (hasSpreadElements) {
					code.overwrite(this.end - 1, this.end, ')');
				}
			}
		}
	}
}

function removeTrailingComma(code, c) {
	while (code.original[c] !== ')') {
		if (code.original[c] === ',') {
			code.remove(c, c + 1);
			return;
		}

		if (code.original[c] === '/') {
			if (code.original[c + 1] === '/') {
				c = code.original.indexOf('\n', c);
			} else {
				c = code.original.indexOf('*/', c) + 1;
			}
		}
		c += 1;
	}
}

class ArrowFunctionExpression extends Node {
	initialise(transforms) {
		if (this.async && transforms.asyncAwait) {
			CompileError.missingTransform("async arrow functions", "asyncAwait", this);
		}
		this.body.createScope();
		super.initialise(transforms);
	}

	transpile(code, transforms) {
		var openParensPos = this.start;
		for (var end = (this.body || this.params[0]).start - 1; code.original[openParensPos] !== '(' && openParensPos < end;) {
			++openParensPos;
		}
		if (code.original[openParensPos] !== '(') { openParensPos = -1; }
		var naked = openParensPos === -1;

		if (transforms.arrow || this.needsArguments(transforms)) {
			// remove arrow
			var charIndex = this.body.start;
			while (code.original[charIndex] !== '=') {
				charIndex -= 1;
			}
			code.remove(charIndex, this.body.start);

			super.transpile(code, transforms);

			// wrap naked parameter
			if (naked) {
				code.prependRight(this.params[0].start, '(');
				code.appendLeft(this.params[0].end, ')');
			}

			// standalone expression statement
			var standalone = this.parent && this.parent.type === 'ExpressionStatement';
			var start, text = standalone ? '!' : '';
			if (this.async) { text += 'async '; }
			text += 'function';
			if (!standalone) { text += ' '; }
			if (naked) {
				start = this.params[0].start;
			} else {
				start = openParensPos;
			}
			// add function
			if (start > this.start) {
				code.overwrite(this.start, start, text);
			} else {
				code.prependRight(this.start, text);
			}
		} else {
			super.transpile(code, transforms);
		}

		if (transforms.trailingFunctionCommas && this.params.length && !naked) {
			removeTrailingComma(code, this.params[this.params.length - 1].end);
		}
	}

	// Returns whether any transforms that will happen use `arguments`
	needsArguments(transforms) {
		return (
			transforms.spreadRest &&
			this.params.filter(param => param.type === 'RestElement').length > 0
		);
	}
}

function checkConst(identifier, scope) {
	var declaration = scope.findDeclaration(identifier.name);
	if (declaration && declaration.kind === 'const') {
		throw new CompileError(`${identifier.name} is read-only`, identifier);
	}
}

class AssignmentExpression extends Node {
	initialise(transforms) {
		if (this.left.type === 'Identifier') {
			var declaration = this.findScope(false).findDeclaration(this.left.name);
			// special case ??? https://gitlab.com/Rich-Harris/buble/issues/11
			var statement = declaration && declaration.node.ancestor(3);
			if (
				statement &&
				statement.type === 'ForStatement' &&
				statement.body.contains(this)
			) {
				statement.reassigned[this.left.name] = true;
			}
		}

		super.initialise(transforms);
	}

	transpile(code, transforms) {
		if (this.left.type === 'Identifier') {
			// Do this check after everything has been initialized to find
			// shadowing declarations after this expression
			checkConst(this.left, this.findScope(false));
		}

		if (this.operator === '**=' && transforms.exponentiation) {
			this.transpileExponentiation(code, transforms);
		} else if (/Pattern/.test(this.left.type) && transforms.destructuring) {
			this.transpileDestructuring(code);
		}

		super.transpile(code, transforms);
	}

	transpileDestructuring(code) {
		var writeScope = this.findScope(true);
		var lookupScope = this.findScope(false);
		var assign = writeScope.createDeclaration('assign');
		code.appendRight(this.left.end, `(${assign}`);

		code.appendLeft(this.right.end, ', ');
		var statementGenerators = [];
		destructure(
			code,
			id => writeScope.createDeclaration(id),
			node => {
				var name = lookupScope.resolveName(node.name);
				checkConst(node, lookupScope);
				return name;
			},
			this.left,
			assign,
			true,
			statementGenerators
		);

		var suffix = ', ';
		statementGenerators.forEach((fn, j) => {
			if (j === statementGenerators.length - 1) {
				suffix = '';
			}

			fn(this.end, '', suffix);
		});

		if (this.unparenthesizedParent().type === 'ExpressionStatement') {
			// no rvalue needed for expression statement
			code.prependRight(this.end, `)`);
		} else {
			// destructuring is part of an expression - need an rvalue
			code.appendRight(this.end, `, ${assign})`);
		}
	}

	transpileExponentiation(code) {
		var scope = this.findScope(false);

		// first, the easy part ??? `**=` -> `=`
		var charIndex = this.left.end;
		while (code.original[charIndex] !== '*') { charIndex += 1; }
		code.remove(charIndex, charIndex + 2);

		// how we do the next part depends on a number of factors ??? whether
		// this is a top-level statement, and whether we're updating a
		// simple or complex reference
		var base;

		var left = this.left.unparenthesize();

		if (left.type === 'Identifier') {
			base = scope.resolveName(left.name);
		} else if (left.type === 'MemberExpression') {
			var object;
			var needsObjectVar = false;
			var property;
			var needsPropertyVar = false;

			var statement = this.findNearest(/(?:Statement|Declaration)$/);
			var i0 = statement.getIndentation();

			if (left.property.type === 'Identifier') {
				property = left.computed
					? scope.resolveName(left.property.name)
					: left.property.name;
			} else {
				property = scope.createDeclaration('property');
				needsPropertyVar = true;
			}

			if (left.object.type === 'Identifier') {
				object = scope.resolveName(left.object.name);
			} else {
				object = scope.createDeclaration('object');
				needsObjectVar = true;
			}

			if (left.start === statement.start) {
				if (needsObjectVar && needsPropertyVar) {
					code.prependRight(statement.start, `${object} = `);
					code.overwrite(
						left.object.end,
						left.property.start,
						`;\n${i0}${property} = `
					);
					code.overwrite(
						left.property.end,
						left.end,
						`;\n${i0}${object}[${property}]`
					);
				} else if (needsObjectVar) {
					code.prependRight(statement.start, `${object} = `);
					code.appendLeft(left.object.end, `;\n${i0}`);
					code.appendLeft(left.object.end, object);
				} else if (needsPropertyVar) {
					code.prependRight(left.property.start, `${property} = `);
					code.appendLeft(left.property.end, `;\n${i0}`);
					code.move(left.property.start, left.property.end, this.start);

					code.appendLeft(left.object.end, `[${property}]`);
					code.remove(left.object.end, left.property.start);
					code.remove(left.property.end, left.end);
				}
			} else {
				if (needsObjectVar && needsPropertyVar) {
					code.prependRight(left.start, `( ${object} = `);
					code.overwrite(
						left.object.end,
						left.property.start,
						`, ${property} = `
					);
					code.overwrite(
						left.property.end,
						left.end,
						`, ${object}[${property}]`
					);
				} else if (needsObjectVar) {
					code.prependRight(left.start, `( ${object} = `);
					code.appendLeft(left.object.end, `, ${object}`);
				} else if (needsPropertyVar) {
					code.prependRight(left.property.start, `( ${property} = `);
					code.appendLeft(left.property.end, `, `);
					code.move(left.property.start, left.property.end, left.start);

					code.overwrite(left.object.end, left.property.start, `[${property}]`);
					code.remove(left.property.end, left.end);
				}

				if (needsPropertyVar) {
					code.appendLeft(this.end, ` )`);
				}
			}

			base =
				object +
				(left.computed || needsPropertyVar ? `[${property}]` : `.${property}`);
		}

		code.prependRight(this.right.start, `Math.pow( ${base}, `);
		code.appendLeft(this.right.end, ` )`);
	}
}

class AwaitExpression extends Node {
	initialise(transforms) {
		if (transforms.asyncAwait) {
			CompileError.missingTransform("await", "asyncAwait", this);
		}
		super.initialise(transforms);
	}
}

class BinaryExpression extends Node {
	transpile(code, transforms) {
		if (this.operator === '**' && transforms.exponentiation) {
			code.prependRight(this.start, `Math.pow( `);
			code.overwrite(this.left.end, this.right.start, `, `);
			code.appendLeft(this.end, ` )`);
		}
		super.transpile(code, transforms);
	}
}

var loopStatement = /(?:For(?:In|Of)?|While)Statement/;

class BreakStatement extends Node {
	initialise() {
		var loop = this.findNearest(loopStatement);
		var switchCase = this.findNearest('SwitchCase');

		if (loop && (!switchCase || loop.depth > switchCase.depth)) {
			loop.canBreak = true;
			this.loop = loop;
		}
	}

	transpile(code) {
		if (this.loop && this.loop.shouldRewriteAsFunction) {
			if (this.label)
				{ throw new CompileError(
					'Labels are not currently supported in a loop with locally-scoped variables',
					this
				); }
			code.overwrite(this.start, this.start + 5, `return 'break'`);
		}
	}
}

class CallExpression extends Node {
	initialise(transforms) {
		if (transforms.spreadRest && this.arguments.length > 1) {
			var lexicalBoundary = this.findLexicalBoundary();

			var i = this.arguments.length;
			while (i--) {
				var arg = this.arguments[i];
				if (arg.type === 'SpreadElement' && isArguments(arg.argument)) {
					this.argumentsArrayAlias = lexicalBoundary.getArgumentsArrayAlias();
				}
			}
		}

		super.initialise(transforms);
	}

	transpile(code, transforms) {
		if (transforms.spreadRest && this.arguments.length) {
			inlineSpreads(code, this, this.arguments);
			// this.arguments.length may have changed, must retest.
		}

		if (transforms.spreadRest && this.arguments.length) {
			var hasSpreadElements = false;
			var context;

			var firstArgument = this.arguments[0];

			if (this.arguments.length === 1) {
				if (firstArgument.type === 'SpreadElement') {
					code.remove(firstArgument.start, firstArgument.argument.start);
					hasSpreadElements = true;
				}
			} else {
				hasSpreadElements = spread(
					code,
					this.arguments,
					firstArgument.start,
					this.argumentsArrayAlias
				);
			}

			if (hasSpreadElements) {
				// we need to handle super() and super.method() differently
				// due to its instance
				var _super = null;
				if (this.callee.type === 'Super') {
					_super = this.callee;
				} else if (
					this.callee.type === 'MemberExpression' &&
					this.callee.object.type === 'Super'
				) {
					_super = this.callee.object;
				}

				if (!_super && this.callee.type === 'MemberExpression') {
					if (this.callee.object.type === 'Identifier') {
						context = this.callee.object.name;
					} else {
						context = this.findScope(true).createDeclaration('ref');
						var callExpression = this.callee.object;
						code.prependRight(callExpression.start, `(${context} = `);
						code.appendLeft(callExpression.end, `)`);
					}
				} else {
					context = 'void 0';
				}

				code.appendLeft(this.callee.end, '.apply');

				if (_super) {
					_super.noCall = true; // bit hacky...

					if (this.arguments.length > 1) {
						if (firstArgument.type === 'SpreadElement') {
							if (needsParentheses(firstArgument.argument)) {
								code.prependRight(firstArgument.start, `( `);
							}
						} else {
							code.prependRight(firstArgument.start, `[ `);
						}

						code.appendLeft(
							this.arguments[this.arguments.length - 1].end,
							' )'
						);
					}
				} else if (this.arguments.length === 1) {
					code.prependRight(firstArgument.start, `${context}, `);
				} else {
					if (firstArgument.type === 'SpreadElement') {
						if (needsParentheses(firstArgument.argument)) {
							code.appendLeft(firstArgument.start, `${context}, ( `);
						} else {
							code.appendLeft(firstArgument.start, `${context}, `);
						}
					} else {
						code.appendLeft(firstArgument.start, `${context}, [ `);
					}

					code.appendLeft(this.arguments[this.arguments.length - 1].end, ' )');
				}
			}
		}

		if (transforms.trailingFunctionCommas && this.arguments.length) {
			removeTrailingComma(code, this.arguments[this.arguments.length - 1].end);
		}

		super.transpile(code, transforms);
	}
}

class CatchClause extends Node {
	initialise(transforms) {
		this.createdDeclarations = [];
		this.scope = new Scope({
			block: true,
			parent: this.parent.findScope(false),
			declare: id => this.createdDeclarations.push(id)
		});

		this.scope.addDeclaration(this.param, 'catch');

		super.initialise(transforms);
		this.scope.consolidate();
	}

	findScope(functionScope) {
		return functionScope
			? this.parent.findScope(functionScope)
			: this.scope;
	}
}

// TODO this code is pretty wild, tidy it up
class ClassBody extends Node {
	transpile(code, transforms, inFunctionExpression, superName) {
		if (transforms.classes) {
			var name = this.parent.name;

			var indentStr = code.getIndentString();
			var i0 =
				this.getIndentation() + (inFunctionExpression ? indentStr : '');
			var i1 = i0 + indentStr;

			var constructorIndex = findIndex(
				this.body,
				node => node.kind === 'constructor'
			);
			var constructor = this.body[constructorIndex];

			var introBlock = '';
			var outroBlock = '';

			if (this.body.length) {
				code.remove(this.start, this.body[0].start);
				code.remove(this.body[this.body.length - 1].end, this.end);
			} else {
				code.remove(this.start, this.end);
			}

			if (constructor) {
				constructor.value.body.isConstructorBody = true;

				var previousMethod = this.body[constructorIndex - 1];
				var nextMethod = this.body[constructorIndex + 1];

				// ensure constructor is first
				if (constructorIndex > 0) {
					code.remove(previousMethod.end, constructor.start);
					code.move(
						constructor.start,
						nextMethod ? nextMethod.start : this.end - 1,
						this.body[0].start
					);
				}

				if (!inFunctionExpression) { code.appendLeft(constructor.end, ';'); }
			}

			var namedFunctions =
				this.program.options.namedFunctionExpressions !== false;
			var namedConstructor =
				namedFunctions ||
				this.parent.superClass ||
				this.parent.type !== 'ClassDeclaration';
			if (this.parent.superClass) {
				var inheritanceBlock = `if ( ${superName} ) ${name}.__proto__ = ${
					superName
				};\n${i0}${name}.prototype = Object.create( ${superName} && ${
					superName
				}.prototype );\n${i0}${name}.prototype.constructor = ${name};`;

				if (constructor) {
					introBlock += `\n\n${i0}` + inheritanceBlock;
				} else {
					var fn =
						`function ${name} () {` +
						(superName
							? `\n${i1}${superName}.apply(this, arguments);\n${i0}}`
							: `}`) +
						(inFunctionExpression ? '' : ';') +
						(this.body.length ? `\n\n${i0}` : '');

					inheritanceBlock = fn + inheritanceBlock;
					introBlock += inheritanceBlock + `\n\n${i0}`;
				}
			} else if (!constructor) {
				var fn$1 = 'function ' + (namedConstructor ? name + ' ' : '') + '() {}';
				if (this.parent.type === 'ClassDeclaration') { fn$1 += ';'; }
				if (this.body.length) { fn$1 += `\n\n${i0}`; }

				introBlock += fn$1;
			}

			var scope = this.findScope(false);

			var prototypeGettersAndSetters = [];
			var staticGettersAndSetters = [];
			var prototypeAccessors;
			var staticAccessors;

			this.body.forEach((method, i) => {
				if ((method.kind === 'get' || method.kind === 'set') && transforms.getterSetter) {
					CompileError.missingTransform("getters and setters", "getterSetter", method);
				}

				if (method.kind === 'constructor') {
					var constructorName = namedConstructor ? ' ' + name : '';
					code.overwrite(
						method.key.start,
						method.key.end,
						`function${constructorName}`
					);
					return;
				}

				if (method.static) {
					var len = code.original[method.start + 6] == ' ' ? 7 : 6;
					code.remove(method.start, method.start + len);
				}

				var isAccessor = method.kind !== 'method';
				var lhs;

				var methodName = method.key.name;
				if (
					reserved[methodName] ||
					method.value.body.scope.references[methodName]
				) {
					methodName = scope.createIdentifier(methodName);
				}

				// when method name is a string or a number let's pretend it's a computed method

				var fake_computed = false;
				if (!method.computed && method.key.type === 'Literal') {
					fake_computed = true;
					method.computed = true;
				}

				if (isAccessor) {
					if (method.computed) {
						throw new Error(
							'Computed accessor properties are not currently supported'
						);
					}

					code.remove(method.start, method.key.start);

					if (method.static) {
						if (!~staticGettersAndSetters.indexOf(method.key.name))
							{ staticGettersAndSetters.push(method.key.name); }
						if (!staticAccessors)
							{ staticAccessors = scope.createIdentifier('staticAccessors'); }

						lhs = `${staticAccessors}`;
					} else {
						if (!~prototypeGettersAndSetters.indexOf(method.key.name))
							{ prototypeGettersAndSetters.push(method.key.name); }
						if (!prototypeAccessors)
							{ prototypeAccessors = scope.createIdentifier('prototypeAccessors'); }

						lhs = `${prototypeAccessors}`;
					}
				} else {
					lhs = method.static ? `${name}` : `${name}.prototype`;
				}

				if (!method.computed) { lhs += '.'; }

				var insertNewlines =
					(constructorIndex > 0 && i === constructorIndex + 1) ||
					(i === 0 && constructorIndex === this.body.length - 1);

				if (insertNewlines) { lhs = `\n\n${i0}${lhs}`; }

				var c = method.key.end;
				if (method.computed) {
					if (fake_computed) {
						code.prependRight(method.key.start, '[');
						code.appendLeft(method.key.end, ']');
					} else {
						while (code.original[c] !== ']') { c += 1; }
						c += 1;
					}
				}

				var funcName =
					method.computed || isAccessor || !namedFunctions
						? ''
						: `${methodName} `;
				var rhs =
					(isAccessor ? `.${method.kind}` : '') +
					` = ${method.value.async ? 'async ' : ''}function` +
					(method.value.generator ? '* ' : ' ') +
					funcName;
				code.remove(c, method.value.start);
				code.prependRight(method.value.start, rhs);
				code.appendLeft(method.end, ';');

				if (method.value.generator) { code.remove(method.start, method.key.start); }

				var start = method.key.start;
				if (method.computed && !fake_computed) {
					while (code.original[start] != '[') {
						--start;
					}
				}
				if (method.start < start) {
					code.overwrite(method.start, start, lhs);
				} else {
					code.prependRight(method.start, lhs);
				}
			});

			if (prototypeGettersAndSetters.length || staticGettersAndSetters.length) {
				var intro = [];
				var outro = [];

				if (prototypeGettersAndSetters.length) {
					intro.push(
						`var ${prototypeAccessors} = { ${prototypeGettersAndSetters
							.map(name => `${name}: { configurable: true }`)
							.join(',')} };`
					);
					outro.push(
						`Object.defineProperties( ${name}.prototype, ${
							prototypeAccessors
						} );`
					);
				}

				if (staticGettersAndSetters.length) {
					intro.push(
						`var ${staticAccessors} = { ${staticGettersAndSetters
							.map(name => `${name}: { configurable: true }`)
							.join(',')} };`
					);
					outro.push(`Object.defineProperties( ${name}, ${staticAccessors} );`);
				}

				if (constructor) { introBlock += `\n\n${i0}`; }
				introBlock += intro.join(`\n${i0}`);
				if (!constructor) { introBlock += `\n\n${i0}`; }

				outroBlock += `\n\n${i0}` + outro.join(`\n${i0}`);
			}

			if (constructor) {
				code.appendLeft(constructor.end, introBlock);
			} else {
				code.prependRight(this.start, introBlock);
			}

			code.appendLeft(this.end, outroBlock);
		}

		super.transpile(code, transforms);
	}
}

// TODO this function is slightly flawed ??? it works on the original string,
// not its current edited state.
// That's not a problem for the way that it's currently used, but it could
// be in future...
function deindent(node, code) {
	var start = node.start;
	var end = node.end;

	var indentStr = code.getIndentString();
	var indentStrLen = indentStr.length;
	var indentStart = start - indentStrLen;

	if (
		!node.program.indentExclusions[indentStart] &&
		code.original.slice(indentStart, start) === indentStr
	) {
		code.remove(indentStart, start);
	}

	var pattern = new RegExp(indentStr + '\\S', 'g');
	var slice = code.original.slice(start, end);
	var match;

	while ((match = pattern.exec(slice))) {
		var removeStart = start + match.index;
		if (!node.program.indentExclusions[removeStart]) {
			code.remove(removeStart, removeStart + indentStrLen);
		}
	}
}

class ClassDeclaration extends Node {
	initialise(transforms) {
		if (this.id) {
			this.name = this.id.name;
			this.findScope(true).addDeclaration(this.id, 'class');
		} else {
			this.name = this.findScope(true).createIdentifier("defaultExport");
		}

		super.initialise(transforms);
	}

	transpile(code, transforms) {
		if (transforms.classes) {
			if (!this.superClass) { deindent(this.body, code); }

			var superName =
				this.superClass && (this.superClass.name || 'superclass');

			var i0 = this.getIndentation();
			var i1 = i0 + code.getIndentString();

			// if this is an export default statement, we have to move the export to
			// after the declaration, because `export default var Foo = ...` is illegal
			var isExportDefaultDeclaration = this.parent.type === 'ExportDefaultDeclaration';

			if (isExportDefaultDeclaration) {
				code.remove(this.parent.start, this.start);
			}

			var c = this.start;
			if (this.id) {
				code.overwrite(c, this.id.start, 'var ');
				c = this.id.end;
			} else {
				code.prependLeft(c, `var ${this.name}`);
			}

			if (this.superClass) {
				if (this.superClass.end === this.body.start) {
					code.remove(c, this.superClass.start);
					code.appendLeft(c, ` = /*@__PURE__*/(function (${superName}) {\n${i1}`);
				} else {
					code.overwrite(c, this.superClass.start, ' = ');
					code.overwrite(
						this.superClass.end,
						this.body.start,
						`/*@__PURE__*/(function (${superName}) {\n${i1}`
					);
				}
			} else {
				if (c === this.body.start) {
					code.appendLeft(c, ' = ');
				} else {
					code.overwrite(c, this.body.start, ' = ');
				}
			}

			this.body.transpile(code, transforms, !!this.superClass, superName);

			var syntheticDefaultExport =
				isExportDefaultDeclaration
					? `\n\n${i0}export default ${this.name};`
					: '';
			if (this.superClass) {
				code.appendLeft(this.end, `\n\n${i1}return ${this.name};\n${i0}}(`);
				code.move(this.superClass.start, this.superClass.end, this.end);
				code.prependRight(this.end, `));${syntheticDefaultExport}`);
			} else if (syntheticDefaultExport) {
				code.prependRight(this.end, syntheticDefaultExport);
			}
		} else {
			this.body.transpile(code, transforms, false, null);
		}
	}
}

class ClassExpression extends Node {
	initialise(transforms) {
		this.name = (this.id
			? this.id.name
			: this.parent.type === 'VariableDeclarator'
				? this.parent.id.name
				: this.parent.type !== 'AssignmentExpression'
					? null
					: this.parent.left.type === 'Identifier'
						? this.parent.left.name
						: this.parent.left.type === 'MemberExpression'
							? this.parent.left.property.name
							: null) || this.findScope(true).createIdentifier('anonymous');

		super.initialise(transforms);
	}

	transpile(code, transforms) {
		if (transforms.classes) {
			var superName = this.superClass && (this.superClass.name || 'superclass');
			if (superName === this.name) {
				superName = this.findScope(true).createIdentifier(this.name);
			}

			var i0 = this.getIndentation();
			var i1 = i0 + code.getIndentString();

			if (this.superClass) {
				code.remove(this.start, this.superClass.start);
				code.remove(this.superClass.end, this.body.start);
				code.appendRight(this.start, `/*@__PURE__*/(function (${superName}) {\n${i1}`);
			} else {
				code.overwrite(this.start, this.body.start, `/*@__PURE__*/(function () {\n${i1}`);
			}

			this.body.transpile(code, transforms, true, superName);

			var superClass = '';
			if (this.superClass) {
				superClass = code.slice(this.superClass.start, this.superClass.end);
				code.remove(this.superClass.start, this.superClass.end);
			}
			code.appendLeft(this.end, `\n\n${i1}return ${this.name};\n${i0}}(${superClass}))`);
		} else {
			this.body.transpile(code, transforms, false);
		}
	}
}

class ContinueStatement extends Node {
	transpile(code) {
		var loop = this.findNearest(loopStatement);
		if (loop.shouldRewriteAsFunction) {
			if (this.label)
				{ throw new CompileError(
					'Labels are not currently supported in a loop with locally-scoped variables',
					this
				); }
			code.overwrite(this.start, this.start + 8, 'return');
		}
	}
}

class ExportDefaultDeclaration extends Node {
	initialise(transforms) {
		if (transforms.moduleExport)
			{ CompileError.missingTransform("export", "moduleExport", this); }
		super.initialise(transforms);
	}
}

class ExportNamedDeclaration extends Node {
	initialise(transforms) {
		if (transforms.moduleExport)
			{ CompileError.missingTransform("export", "moduleExport", this); }
		super.initialise(transforms);
	}
}

class LoopStatement extends Node {
	findScope(functionScope) {
		return functionScope || !this.createdScope
			? this.parent.findScope(functionScope)
			: this.body.scope;
	}

	initialise(transforms) {
		this.body.createScope();
		this.createdScope = true;

		// this is populated as and when reassignments occur
		this.reassigned = Object.create(null);
		this.aliases = Object.create(null);

		this.thisRefs = [];

		super.initialise(transforms);
		if (this.scope) {
			this.scope.consolidate();
		}

		var declarations = Object.assign({}, this.body.scope.declarations);
		if (this.scope) {
			Object.assign(declarations, this.scope.declarations);
		}

		if (transforms.letConst) {
			// see if any block-scoped declarations are referenced
			// inside function expressions
			var names = Object.keys(declarations);

			var i = names.length;
			while (i--) {
				var name = names[i];
				var declaration = declarations[name];

				var j = declaration.instances.length;
				while (j--) {
					var instance = declaration.instances[j];
					var nearestFunctionExpression = instance.findNearest(/Function/);

					if (
						nearestFunctionExpression &&
						nearestFunctionExpression.depth > this.depth
					) {
						this.shouldRewriteAsFunction = true;
						for (var i$1 = 0, list = this.thisRefs; i$1 < list.length; i$1 += 1) {
							var node = list[i$1];

							node.alias = node.alias || node.findLexicalBoundary().getThisAlias();
						}
						break;
					}
				}

				if (this.shouldRewriteAsFunction) { break; }
			}
		}
	}

	transpile(code, transforms) {
		var needsBlock =
			this.type != 'ForOfStatement' &&
			(this.body.type !== 'BlockStatement' ||
				(this.body.type === 'BlockStatement' && this.body.synthetic));

		if (this.shouldRewriteAsFunction) {
			var i0 = this.getIndentation();
			var i1 = i0 + code.getIndentString();

			var argString = this.args ? ` ${this.args.join(', ')} ` : '';
			var paramString = this.params ? ` ${this.params.join(', ')} ` : '';

			var functionScope = this.findScope(true);
			var loop = functionScope.createIdentifier('loop');

			var before =
				`var ${loop} = function (${paramString}) ` +
				(this.body.synthetic ? `{\n${i0}${code.getIndentString()}` : '');
			var after = (this.body.synthetic ? `\n${i0}}` : '') + `;\n\n${i0}`;

			code.prependRight(this.body.start, before);
			code.appendLeft(this.body.end, after);
			code.move(this.start, this.body.start, this.body.end);

			if (this.canBreak || this.canReturn) {
				var returned = functionScope.createIdentifier('returned');

				var insert = `{\n${i1}var ${returned} = ${loop}(${argString});\n`;
				if (this.canBreak)
					{ insert += `\n${i1}if ( ${returned} === 'break' ) break;`; }
				if (this.canReturn)
					{ insert += `\n${i1}if ( ${returned} ) return ${returned}.v;`; }
				insert += `\n${i0}}`;

				code.prependRight(this.body.end, insert);
			} else {
				var callExpression = `${loop}(${argString});`;

				if (this.type === 'DoWhileStatement') {
					code.overwrite(
						this.start,
						this.body.start,
						`do {\n${i1}${callExpression}\n${i0}}`
					);
				} else {
					code.prependRight(this.body.end, callExpression);
				}
			}
		} else if (needsBlock) {
			code.appendLeft(this.body.start, '{ ');
			code.prependRight(this.body.end, ' }');
		}

		super.transpile(code, transforms);
	}
}

class ForStatement extends LoopStatement {
	initialise(transforms) {
		this.createdDeclarations = [];

		this.scope = new Scope({
			block: true,
			parent: this.parent.findScope(false),
			declare: id => this.createdDeclarations.push(id)
		});

		super.initialise(transforms);
	}

	findScope(functionScope) {
		return functionScope
			? this.parent.findScope(functionScope)
			: this.scope;
	}

	transpile(code, transforms) {
		var i1 = this.getIndentation() + code.getIndentString();

		if (this.shouldRewriteAsFunction) {
			// which variables are declared in the init statement?
			var names = this.init && this.init.type === 'VariableDeclaration'
				? this.init.declarations.map(declarator => extractNames(declarator.id))
				: [];

			var aliases = this.aliases;

			this.args = names.map(
				name => (name in this.aliases ? this.aliases[name].outer : name)
			);
			this.params = names.map(
				name => (name in this.aliases ? this.aliases[name].inner : name)
			);

			var updates = Object.keys(this.reassigned).map(
				name => `${aliases[name].outer} = ${aliases[name].inner};`
			);

			if (updates.length) {
				if (this.body.synthetic) {
					code.appendLeft(this.body.body[0].end, `; ${updates.join(` `)}`);
				} else {
					var lastStatement = this.body.body[this.body.body.length - 1];
					code.appendLeft(
						lastStatement.end,
						`\n\n${i1}${updates.join(`\n${i1}`)}`
					);
				}
			}
		}

		super.transpile(code, transforms);
	}
}

class ForInStatement extends LoopStatement {
	initialise(transforms) {
		this.createdDeclarations = [];

		this.scope = new Scope({
			block: true,
			parent: this.parent.findScope(false),
			declare: id => this.createdDeclarations.push(id)
		});

		super.initialise(transforms);
	}

	findScope(functionScope) {
		return functionScope
			? this.parent.findScope(functionScope)
			: this.scope;
	}

	transpile(code, transforms) {
		var hasDeclaration = this.left.type === 'VariableDeclaration';

		if (this.shouldRewriteAsFunction) {
			// which variables are declared in the init statement?
			var names = hasDeclaration
				? this.left.declarations.map(declarator => extractNames(declarator.id))
				: [];

			this.args = names.map(
				name => (name in this.aliases ? this.aliases[name].outer : name)
			);
			this.params = names.map(
				name => (name in this.aliases ? this.aliases[name].inner : name)
			);
		}

		super.transpile(code, transforms);

		var maybePattern = hasDeclaration ? this.left.declarations[0].id : this.left;
		if (maybePattern.type !== 'Identifier' && maybePattern.type !== 'MemberExpression') {
			this.destructurePattern(code, maybePattern, hasDeclaration);
		}
	}

	destructurePattern(code, pattern, isDeclaration) {
		var scope = this.findScope(true);
		var i0 = this.getIndentation();
		var i1 = i0 + code.getIndentString();

		var ref = scope.createIdentifier('ref');

		var bodyStart = this.body.body.length ? this.body.body[0].start : this.body.start + 1;

		code.move(pattern.start, pattern.end, bodyStart);

		code.prependRight(pattern.end, isDeclaration ? ref : `var ${ref}`);

		var statementGenerators = [];
		destructure(
			code,
			id => scope.createIdentifier(id),
			(ref) => {
				var name = ref.name;

				return scope.resolveName(name);
		},
			pattern,
			ref,
			false,
			statementGenerators
		);

		var suffix = `;\n${i1}`;
		statementGenerators.forEach((fn, i) => {
			if (i === statementGenerators.length - 1) {
				suffix = `;\n\n${i1}`;
			}

			fn(bodyStart, '', suffix);
		});
	}
}

class ForOfStatement extends LoopStatement {
	initialise(transforms) {
		if (transforms.forOf && !transforms.dangerousForOf)
			{ CompileError.missingTransform("for-of statements", "forOf", this, "dangerousForOf"); }
		if (this.await && transforms.asyncAwait)
			{ CompileError.missingTransform("for-await-of statements", "asyncAwait", this); }

		this.createdDeclarations = [];

		this.scope = new Scope({
			block: true,
			parent: this.parent.findScope(false),
			declare: id => this.createdDeclarations.push(id)
		});

		super.initialise(transforms);
	}

	findScope(functionScope) {
		return functionScope
			? this.parent.findScope(functionScope)
			: this.scope;
	}

	transpile(code, transforms) {
		super.transpile(code, transforms);
		if (!transforms.dangerousForOf) { return; }

		// edge case (#80)
		if (!this.body.body[0]) {
			if (
				this.left.type === 'VariableDeclaration' &&
				this.left.kind === 'var'
			) {
				code.remove(this.start, this.left.start);
				code.appendLeft(this.left.end, ';');
				code.remove(this.left.end, this.end);
			} else {
				code.remove(this.start, this.end);
			}

			return;
		}

		var scope = this.findScope(true);
		var i0 = this.getIndentation();
		var i1 = i0 + code.getIndentString();

		var key = scope.createIdentifier('i');
		var list = scope.createIdentifier('list');

		if (this.body.synthetic) {
			code.prependRight(this.left.start, `{\n${i1}`);
			code.appendLeft(this.body.body[0].end, `\n${i0}}`);
		}

		var bodyStart = this.body.body[0].start;

		code.remove(this.left.end, this.right.start);
		code.move(this.left.start, this.left.end, bodyStart);

		code.prependRight(this.right.start, `var ${key} = 0, ${list} = `);
		code.appendLeft(this.right.end, `; ${key} < ${list}.length; ${key} += 1`);

		var isDeclaration = this.left.type === 'VariableDeclaration';
		var maybeDestructuring = isDeclaration ? this.left.declarations[0].id : this.left;
		if (maybeDestructuring.type !== 'Identifier') {
			var statementGenerators = [];
			var ref = scope.createIdentifier('ref');
			destructure(
				code,
				id => scope.createIdentifier(id),
				(ref) => {
					var name = ref.name;

					return scope.resolveName(name);
			},
				maybeDestructuring,
				ref,
				!isDeclaration,
				statementGenerators
			);

			var suffix = `;\n${i1}`;
			statementGenerators.forEach((fn, i) => {
				if (i === statementGenerators.length - 1) {
					suffix = `;\n\n${i1}`;
				}

				fn(bodyStart, '', suffix);
			});

			if (isDeclaration) {
				code.appendLeft(this.left.start + this.left.kind.length + 1, ref);
				code.appendLeft(this.left.end, ` = ${list}[${key}];\n${i1}`);
			} else {
				code.appendLeft(this.left.end, `var ${ref} = ${list}[${key}];\n${i1}`);
			}
		} else {
			code.appendLeft(this.left.end, ` = ${list}[${key}];\n\n${i1}`);
		}
	}
}

class FunctionDeclaration extends Node {
	initialise(transforms) {
		if (this.generator && transforms.generator) {
			CompileError.missingTransform("generators", "generator", this);
		}
		if (this.async && transforms.asyncAwait) {
			CompileError.missingTransform("async functions", "asyncAwait", this);
		}

		this.body.createScope();

		if (this.id) {
			this.findScope(true).addDeclaration(this.id, 'function');
		}
		super.initialise(transforms);
	}

	transpile(code, transforms) {
		super.transpile(code, transforms);
		if (transforms.trailingFunctionCommas && this.params.length) {
			removeTrailingComma(code, this.params[this.params.length - 1].end);
		}
	}
}

class FunctionExpression extends Node {
	initialise(transforms) {
		if (this.generator && transforms.generator) {
			CompileError.missingTransform("generators", "generator", this);
		}
		if (this.async && transforms.asyncAwait) {
			CompileError.missingTransform("async functions", "asyncAwait", this);
		}

		this.body.createScope();

		if (this.id) {
			// function expression IDs belong to the child scope...
			this.body.scope.addDeclaration(this.id, 'function');
		}

		super.initialise(transforms);

		var parent = this.parent;
		var methodName;

		if (
			transforms.conciseMethodProperty &&
			parent.type === 'Property' &&
			parent.kind === 'init' &&
			parent.method &&
			parent.key.type === 'Identifier'
		) {
			// object literal concise method
			methodName = parent.key.name;
		} else if (
			transforms.classes &&
			parent.type === 'MethodDefinition' &&
			parent.kind === 'method' &&
			parent.key.type === 'Identifier'
		) {
			// method definition in a class
			methodName = parent.key.name;
		} else if (this.id && this.id.type === 'Identifier') {
			// naked function expression
			methodName = this.id.alias || this.id.name;
		}

		if (methodName) {
			for (var i$1 = 0, list$1 = this.params; i$1 < list$1.length; i$1 += 1) {
				var param = list$1[i$1];

				if (param.type === 'Identifier' && methodName === param.name) {
					// workaround for Safari 9/WebKit bug:
					// https://gitlab.com/Rich-Harris/buble/issues/154
					// change parameter name when same as method name

					var scope = this.body.scope;
					var declaration = scope.declarations[methodName];

					var alias = scope.createIdentifier(methodName);
					param.alias = alias;

					for (var i = 0, list = declaration.instances; i < list.length; i += 1) {
						var identifier = list[i];

						identifier.alias = alias;
					}

					break;
				}
			}
		}
	}

	transpile(code, transforms) {
		super.transpile(code, transforms);
		if (transforms.trailingFunctionCommas && this.params.length) {
			removeTrailingComma(code, this.params[this.params.length - 1].end);
		}
	}
}

function isReference(node, parent) {
	if (node.type === 'MemberExpression') {
		return !node.computed && isReference(node.object, node);
	}

	if (node.type === 'Identifier') {
		// the only time we could have an identifier node without a parent is
		// if it's the entire body of a function without a block statement ???
		// i.e. an arrow function expression like `a => a`
		if (!parent) { return true; }

		if (/(Function|Class)Expression/.test(parent.type)) { return false; }

		if (parent.type === 'VariableDeclarator') { return node === parent.init; }

		// TODO is this right?
		if (
			parent.type === 'MemberExpression' ||
			parent.type === 'MethodDefinition'
		) {
			return parent.computed || node === parent.object;
		}

		if (parent.type === 'ArrayPattern') { return false; }

		// disregard the `bar` in `{ bar: foo }`, but keep it in `{ [bar]: foo }`
		if (parent.type === 'Property') {
			if (parent.parent.type === 'ObjectPattern') { return false; }
			return parent.computed || node === parent.value;
		}

		// disregard the `bar` in `class Foo { bar () {...} }`
		if (parent.type === 'MethodDefinition') { return false; }

		// disregard the `bar` in `export { foo as bar }`
		if (parent.type === 'ExportSpecifier' && node !== parent.local)
			{ return false; }

		return true;
	}
}

class Identifier extends Node {
	findScope(functionScope) {
		if (this.parent.params && ~this.parent.params.indexOf(this)) {
			return this.parent.body.scope;
		}

		if (this.parent.type === 'FunctionExpression' && this === this.parent.id) {
			return this.parent.body.scope;
		}

		return this.parent.findScope(functionScope);
	}

	initialise(transforms) {
		if (this.isLabel()) {
			return;
		}

		if (isReference(this, this.parent)) {
			if (
				transforms.arrow &&
				this.name === 'arguments' &&
				!this.findScope(false).contains(this.name)
			) {
				var lexicalBoundary = this.findLexicalBoundary();
				var arrowFunction = this.findNearest('ArrowFunctionExpression');
				var loop = this.findNearest(loopStatement);

				if (arrowFunction && arrowFunction.depth > lexicalBoundary.depth) {
					this.alias = lexicalBoundary.getArgumentsAlias();
				}

				if (
					loop &&
					loop.body.contains(this) &&
					loop.depth > lexicalBoundary.depth
				) {
					this.alias = lexicalBoundary.getArgumentsAlias();
				}
			}

			this.findScope(false).addReference(this);
		}
	}

	isLabel() {
		switch (this.parent.type) {
			case 'BreakStatement': return true;
			case 'ContinueStatement': return true;
			case 'LabeledStatement': return true;
			default: return false;
		}
	}

	transpile(code) {
		if (this.alias) {
			code.overwrite(this.start, this.end, this.alias, {
				storeName: true,
				contentOnly: true
			});
		}
	}
}

class IfStatement extends Node {
	initialise(transforms) {
		super.initialise(transforms);
	}

	transpile(code, transforms) {
		if (
			this.consequent.type !== 'BlockStatement' ||
			(this.consequent.type === 'BlockStatement' && this.consequent.synthetic)
		) {
			code.appendLeft(this.consequent.start, '{ ');
			code.prependRight(this.consequent.end, ' }');
		}

		if (
			this.alternate &&
			this.alternate.type !== 'IfStatement' &&
			(this.alternate.type !== 'BlockStatement' ||
				(this.alternate.type === 'BlockStatement' && this.alternate.synthetic))
		) {
			code.appendLeft(this.alternate.start, '{ ');
			code.prependRight(this.alternate.end, ' }');
		}

		super.transpile(code, transforms);
	}
}

class Import extends Node {
	initialise(transforms) {
		if (transforms.moduleImport) {
			CompileError.missingTransform("dynamic import expressions", "moduleImport", this);
		}
		super.initialise(transforms);
	}
}

class ImportDeclaration extends Node {
	initialise(transforms) {
		if (transforms.moduleImport)
			{ CompileError.missingTransform("import", "moduleImport", this); }
		super.initialise(transforms);
	}
}

class ImportDefaultSpecifier extends Node {
	initialise(transforms) {
		this.findScope(true).addDeclaration(this.local, 'import');
		super.initialise(transforms);
	}
}

class ImportSpecifier extends Node {
	initialise(transforms) {
		this.findScope(true).addDeclaration(this.local, 'import');
		super.initialise(transforms);
	}
}

var hasDashes = val => /-/.test(val);

var formatKey = key => (hasDashes(key) ? `'${key}'` : key);

var formatVal = val => (val ? '' : 'true');

class JSXAttribute extends Node {
	transpile(code, transforms) {
		var ref = this.name;
		var start = ref.start;
		var name = ref.name;

		// Overwrite equals sign if value is present.
		var end = this.value ? this.value.start : this.name.end;

		code.overwrite(start, end, `${formatKey(name)}: ${formatVal(this.value)}`);

		super.transpile(code, transforms);
	}
}

function containsNewLine(node) {
	return (
		node.type === 'JSXText' && !/\S/.test(node.value) && /\n/.test(node.value)
	);
}

class JSXClosingElement extends Node {
	transpile(code) {
		var spaceBeforeParen = true;

		var lastChild = this.parent.children[this.parent.children.length - 1];

		// omit space before closing paren if
		//   a) this is on a separate line, or
		//   b) there are no children but there are attributes
		if (
			(lastChild && containsNewLine(lastChild)) ||
			this.parent.openingElement.attributes.length
		) {
			spaceBeforeParen = false;
		}

		code.overwrite(this.start, this.end, spaceBeforeParen ? ' )' : ')');
	}
}

function containsNewLine$1(node) {
	return (
		node.type === 'JSXText' && !/\S/.test(node.value) && /\n/.test(node.value)
	);
}

class JSXClosingFragment extends Node {
	transpile(code) {
		var spaceBeforeParen = true;

		var lastChild = this.parent.children[this.parent.children.length - 1];

		// omit space before closing paren if this is on a separate line
		if (lastChild && containsNewLine$1(lastChild)) {
			spaceBeforeParen = false;
		}

		code.overwrite(this.start, this.end, spaceBeforeParen ? ' )' : ')');
	}
}

function normalise(str, removeTrailingWhitespace) {

	if (removeTrailingWhitespace && /\n/.test(str)) {
		str = str.replace(/[ \f\n\r\t\v]+$/, '');
	}

	str = str
		.replace(/^\n\r?[ \f\n\r\t\v]+/, '') // remove leading newline + space
		.replace(/[ \f\n\r\t\v]*\n\r?[ \f\n\r\t\v]*/gm, ' '); // replace newlines with spaces

	// TODO prefer single quotes?
	return JSON.stringify(str);
}

class JSXElement extends Node {
	transpile(code, transforms) {
		super.transpile(code, transforms);

		var children = this.children.filter(child => {
			if (child.type !== 'JSXText') { return true; }

			// remove whitespace-only literals, unless on a single line
			return /[^ \f\n\r\t\v]/.test(child.raw) || !/\n/.test(child.raw);
		});

		if (children.length) {
			var c = (this.openingElement || this.openingFragment).end;

			var i;
			for (i = 0; i < children.length; i += 1) {
				var child = children[i];

				if (
					child.type === 'JSXExpressionContainer' &&
					child.expression.type === 'JSXEmptyExpression'
				) ; else {
					var tail =
						code.original[c] === '\n' && child.type !== 'JSXText' ? '' : ' ';
					code.appendLeft(c, `,${tail}`);
				}

				if (child.type === 'JSXText') {
					var str = normalise(child.value, i === children.length - 1);
					code.overwrite(child.start, child.end, str);
				}

				c = child.end;
			}
		}
	}
}

class JSXExpressionContainer extends Node {
	transpile(code, transforms) {
		code.remove(this.start, this.expression.start);
		code.remove(this.expression.end, this.end);

		super.transpile(code, transforms);
	}
}

class JSXFragment extends JSXElement {
}

class JSXOpeningElement extends Node {
	transpile(code, transforms) {
		super.transpile(code, transforms);

		code.overwrite(this.start, this.name.start, `${this.program.jsx}( `);

		var html =
			this.name.type === 'JSXIdentifier' &&
			this.name.name[0] === this.name.name[0].toLowerCase();
		if (html) { code.prependRight(this.name.start, `'`); }

		var len = this.attributes.length;
		var c = this.name.end;

		if (len) {
			var i;

			var hasSpread = false;
			for (i = 0; i < len; i += 1) {
				if (this.attributes[i].type === 'JSXSpreadAttribute') {
					hasSpread = true;
					break;
				}
			}

			c = this.attributes[0].end;

			for (i = 0; i < len; i += 1) {
				var attr = this.attributes[i];

				if (i > 0) {
					if (attr.start === c) { code.prependRight(c, ', '); }
					else { code.overwrite(c, attr.start, ', '); }
				}

				if (hasSpread && attr.type !== 'JSXSpreadAttribute') {
					var lastAttr = this.attributes[i - 1];
					var nextAttr = this.attributes[i + 1];

					if (!lastAttr || lastAttr.type === 'JSXSpreadAttribute') {
						code.prependRight(attr.start, '{ ');
					}

					if (!nextAttr || nextAttr.type === 'JSXSpreadAttribute') {
						code.appendLeft(attr.end, ' }');
					}
				}

				c = attr.end;
			}

			var after;
			var before;
			if (hasSpread) {
				if (len === 1) {
					before = html ? `',` : ',';
				} else {
					if (!this.program.options.objectAssign) {
						throw new CompileError(
							"Mixed JSX attributes ending in spread requires specified objectAssign option with 'Object.assign' or polyfill helper.",
							this
						);
					}
					before = html
						? `', ${this.program.options.objectAssign}({},`
						: `, ${this.program.options.objectAssign}({},`;
					after = ')';
				}
			} else {
				before = html ? `', {` : ', {';
				after = ' }';
			}

			code.prependRight(this.name.end, before);

			if (after) {
				code.appendLeft(this.attributes[len - 1].end, after);
			}
		} else {
			code.appendLeft(this.name.end, html ? `', null` : `, null`);
			c = this.name.end;
		}

		if (this.selfClosing) {
			code.overwrite(c, this.end, this.attributes.length ? `)` : ` )`);
		} else {
			code.remove(c, this.end);
		}
	}
}

class JSXOpeningFragment extends Node {
	transpile(code) {
		code.overwrite(this.start, this.end, `${this.program.jsx}( ${this.program.jsxFragment}, null`);
	}
}

class JSXSpreadAttribute extends Node {
	transpile(code, transforms) {
		code.remove(this.start, this.argument.start);
		code.remove(this.argument.end, this.end);

		super.transpile(code, transforms);
	}
}

var nonAsciiLsOrPs = /[\u2028-\u2029]/g;

class Literal extends Node {
	initialise() {
		if (typeof this.value === 'string') {
			this.program.indentExclusionElements.push(this);
		}
	}

	transpile(code, transforms) {
		if (transforms.numericLiteral) {
			if (this.raw.match(/^0[bo]/i)) {
				code.overwrite(this.start, this.end, String(this.value), {
					storeName: true,
					contentOnly: true
				});
			}
		}

		if (this.regex) {
			var ref = this.regex;
			var pattern = ref.pattern;
			var flags = ref.flags;

			if (transforms.stickyRegExp && /y/.test(flags))
				{ CompileError.missingTransform('the regular expression sticky flag', 'stickyRegExp', this); }
			if (transforms.unicodeRegExp && /u/.test(flags)) {
				code.overwrite(
					this.start,
					this.end,
					`/${rewritePattern(pattern, flags)}/${flags.replace('u', '')}`,
					{
						contentOnly: true
					}
				);
			}
		} else if (typeof this.value === "string" && this.value.match(nonAsciiLsOrPs)) {
			code.overwrite(
				this.start,
				this.end,
				this.raw.replace(nonAsciiLsOrPs, m => m == '\u2028' ? '\\u2028' : '\\u2029'),
				{
					contentOnly: true
				}
			);
		}
	}
}

class MemberExpression extends Node {
	transpile(code, transforms) {
		if (transforms.reservedProperties && reserved[this.property.name]) {
			code.overwrite(this.object.end, this.property.start, `['`);
			code.appendLeft(this.property.end, `']`);
		}

		super.transpile(code, transforms);
	}
}

class NewExpression extends Node {
	initialise(transforms) {
		if (transforms.spreadRest && this.arguments.length) {
			var lexicalBoundary = this.findLexicalBoundary();

			var i = this.arguments.length;
			while (i--) {
				var arg = this.arguments[i];
				if (arg.type === 'SpreadElement' && isArguments(arg.argument)) {
					this.argumentsArrayAlias = lexicalBoundary.getArgumentsArrayAlias();
					break;
				}
			}
		}

		super.initialise(transforms);
	}

	transpile(code, transforms) {
		super.transpile(code, transforms);

		if (transforms.spreadRest && this.arguments.length) {
			inlineSpreads(code, this, this.arguments);
			// this.arguments.length may have changed, must retest.
		}

		if (transforms.spreadRest && this.arguments.length) {
			var firstArgument = this.arguments[0];
			var isNew = true;
			var hasSpreadElements = spread(
				code,
				this.arguments,
				firstArgument.start,
				this.argumentsArrayAlias,
				isNew
			);

			if (hasSpreadElements) {
				code.prependRight(
					this.start + 'new'.length,
					' (Function.prototype.bind.apply('
				);
				code.overwrite(
					this.callee.end,
					firstArgument.start,
					', [ null ].concat( '
				);
				code.appendLeft(this.end, ' ))');
			}
		}

		if (this.arguments.length) {
			removeTrailingComma(code, this.arguments[this.arguments.length - 1].end);
		}
	}
}

class ObjectExpression extends Node {
	transpile(code, transforms) {
		var ref;

		super.transpile(code, transforms);

		var firstPropertyStart = this.start + 1;
		var spreadPropertyCount = 0;
		var computedPropertyCount = 0;
		var firstSpreadProperty = null;
		var firstComputedProperty = null;

		for (var i = 0; i < this.properties.length; ++i) {
			var prop = this.properties[i];
			if (prop.type === 'SpreadElement') {
				// First see if we can inline the spread, to save needing objectAssign.
				var argument = prop.argument;
				if (
					argument.type === 'ObjectExpression' || (
						argument.type === 'Literal' &&
						typeof argument.value !== 'string'
					)
				) {
					if (argument.type === 'ObjectExpression' && argument.properties.length > 0) {
						// Strip the `...{` and the `}` with a possible trailing comma before it,
						// leaving just the possible trailing comma after it.
						code.remove(prop.start, argument.properties[0].start);
						code.remove(argument.properties[argument.properties.length - 1].end, prop.end);
						(ref = this.properties).splice.apply(ref, [ i, 1 ].concat( argument.properties ));
						i--;
					} else {
						// An empty object, boolean, null, undefined, number or regexp (but NOT
						// string) will spread to nothing, so just remove the element altogether,
						// including a possible trailing comma.
						code.remove(prop.start, i === this.properties.length - 1
							? prop.end
							: this.properties[i + 1].start);
						this.properties.splice(i, 1);
						i--;
					}
				} else {
					spreadPropertyCount += 1;
					if (firstSpreadProperty === null) { firstSpreadProperty = i; }
				}
			} else if (prop.computed && transforms.computedProperty) {
				computedPropertyCount += 1;
				if (firstComputedProperty === null) { firstComputedProperty = i; }
			}
		}

		if (spreadPropertyCount && !transforms.objectRestSpread && !(computedPropertyCount && transforms.computedProperty)) {
			spreadPropertyCount = 0;
			firstSpreadProperty = null;
		} else if (spreadPropertyCount) {
			if (!this.program.options.objectAssign) {
				throw new CompileError(
					"Object spread operator requires specified objectAssign option with 'Object.assign' or polyfill helper.",
					this
				);
			}
			var i$1 = this.properties.length;
			while (i$1--) {
				var prop$1 = this.properties[i$1];

				// enclose run of non-spread properties in curlies
				if (prop$1.type === 'Property' && !computedPropertyCount) {
					var lastProp = this.properties[i$1 - 1];
					var nextProp = this.properties[i$1 + 1];

					if (!lastProp || lastProp.type !== 'Property') {
						code.prependRight(prop$1.start, '{');
					}

					if (!nextProp || nextProp.type !== 'Property') {
						code.appendLeft(prop$1.end, '}');
					}
				}

				// Remove ellipsis on spread property
				if (prop$1.type === 'SpreadElement') {
					code.remove(prop$1.start, prop$1.argument.start);
					code.remove(prop$1.argument.end, prop$1.end);
				}
			}

			// wrap the whole thing in Object.assign
			firstPropertyStart = this.properties[0].start;
			if (!computedPropertyCount) {
				code.overwrite(
					this.start,
					firstPropertyStart,
					`${this.program.options.objectAssign}({}, `
				);
				code.overwrite(
					this.properties[this.properties.length - 1].end,
					this.end,
					')'
				);
			} else if (this.properties[0].type === 'SpreadElement') {
				code.overwrite(
					this.start,
					firstPropertyStart,
					`${this.program.options.objectAssign}({}, `
				);
				code.remove(this.end - 1, this.end);
				code.appendRight(this.end, ')');
			} else {
				code.prependLeft(this.start, `${this.program.options.objectAssign}(`);
				code.appendRight(this.end, ')');
			}
		}

		if (computedPropertyCount && transforms.computedProperty) {
			var i0 = this.getIndentation();

			var isSimpleAssignment;
			var name;

			if (
				this.parent.type === 'VariableDeclarator' &&
				this.parent.parent.declarations.length === 1 &&
				this.parent.id.type === 'Identifier'
			) {
				isSimpleAssignment = true;
				name = this.parent.id.alias || this.parent.id.name; // TODO is this right?
			} else if (
				this.parent.type === 'AssignmentExpression' &&
				this.parent.parent.type === 'ExpressionStatement' &&
				this.parent.left.type === 'Identifier'
			) {
				isSimpleAssignment = true;
				name = this.parent.left.alias || this.parent.left.name; // TODO is this right?
			} else if (
				this.parent.type === 'AssignmentPattern' &&
				this.parent.left.type === 'Identifier'
			) {
				isSimpleAssignment = true;
				name = this.parent.left.alias || this.parent.left.name; // TODO is this right?
			}

			if (spreadPropertyCount) { isSimpleAssignment = false; }

			// handle block scoping
			name = this.findScope(false).resolveName(name);

			var start = firstPropertyStart;
			var end = this.end;

			if (isSimpleAssignment) ; else {
				if (
					firstSpreadProperty === null ||
					firstComputedProperty < firstSpreadProperty
				) {
					name = this.findScope(true).createDeclaration('obj');

					code.prependRight(this.start, `( ${name} = `);
				} else { name = null; } // We don't actually need this variable
			}

			var len = this.properties.length;
			var lastComputedProp;
			var sawNonComputedProperty = false;
			var isFirst = true;

			for (var i$2 = 0; i$2 < len; i$2 += 1) {
				var prop$2 = this.properties[i$2];
				var moveStart = i$2 > 0 ? this.properties[i$2 - 1].end : start;

				if (
					prop$2.type === 'Property' &&
					(prop$2.computed || (lastComputedProp && !spreadPropertyCount))
				) {
					if (i$2 === 0) { moveStart = this.start + 1; } // Trim leading whitespace
					lastComputedProp = prop$2;

					if (!name) {
						name = this.findScope(true).createDeclaration('obj');

						var propId = name + (prop$2.computed ? '' : '.');
						code.appendRight(prop$2.start, `( ${name} = {}, ${propId}`);
					} else {
						var propId$1 =
							(isSimpleAssignment ? `;\n${i0}${name}` : `, ${name}`) +
							(prop$2.key.type === 'Literal' || prop$2.computed ? '' : '.');

						if (moveStart < prop$2.start) {
							code.overwrite(moveStart, prop$2.start, propId$1);
						} else {
							code.prependRight(prop$2.start, propId$1);
						}
					}

					var c = prop$2.key.end;
					if (prop$2.computed) {
						while (code.original[c] !== ']') { c += 1; }
						c += 1;
					}
					if (prop$2.key.type === 'Literal' && !prop$2.computed) {
						code.overwrite(
							prop$2.start,
							prop$2.value.start,
							'[' + code.slice(prop$2.start, prop$2.key.end) + '] = '
						);
					} else if (prop$2.shorthand || (prop$2.method && !prop$2.computed && transforms.conciseMethodProperty)) {
						// Replace : with = if Property::transpile inserted the :
						code.overwrite(
							prop$2.key.start,
							prop$2.key.end,
							code.slice(prop$2.key.start, prop$2.key.end).replace(/:/, ' =')
						);
					} else {
						if (prop$2.value.start > c) { code.remove(c, prop$2.value.start); }
						code.prependLeft(c, ' = ');
					}

					// This duplicates behavior from Property::transpile which is disabled
					// for computed properties or if conciseMethodProperty is false
					if (prop$2.method && (prop$2.computed || !transforms.conciseMethodProperty)) {
						if (prop$2.value.generator) { code.remove(prop$2.start, prop$2.key.start); }
						code.prependRight(prop$2.value.start, `function${prop$2.value.generator ? '*' : ''} `);
					}
				} else if (prop$2.type === 'SpreadElement') {
					if (name && i$2 > 0) {
						if (!lastComputedProp) {
							lastComputedProp = this.properties[i$2 - 1];
						}
						code.appendLeft(lastComputedProp.end, `, ${name} )`);

						lastComputedProp = null;
						name = null;
					}
				} else {
					if (!isFirst && spreadPropertyCount) {
						// We are in an Object.assign context, so we need to wrap regular properties
						code.prependRight(prop$2.start, '{');
						code.appendLeft(prop$2.end, '}');
					}
					sawNonComputedProperty = true;
				}
				if (isFirst && (prop$2.type === 'SpreadElement' || prop$2.computed)) {
					var beginEnd = sawNonComputedProperty
						? this.properties[this.properties.length - 1].end
						: this.end - 1;
					// Trim trailing comma because it can easily become a leading comma which is illegal
					if (code.original[beginEnd] == ',') { ++beginEnd; }
					var closing = code.slice(beginEnd, end);
					code.prependLeft(moveStart, closing);
					code.remove(beginEnd, end);
					isFirst = false;
				}

				// Clean up some extranous whitespace
				var c$1 = prop$2.end;
				if (i$2 < len - 1 && !sawNonComputedProperty) {
					while (code.original[c$1] !== ',') { c$1 += 1; }
				} else if (i$2 == len - 1) { c$1 = this.end; }
				if (prop$2.end != c$1) { code.overwrite(prop$2.end, c$1, '', {contentOnly: true}); }
			}

			if (!isSimpleAssignment && name) {
				code.appendLeft(lastComputedProp.end, `, ${name} )`);
			}
		}
	}
}

class Property extends Node {
	initialise(transforms) {
		if ((this.kind === 'get' || this.kind === 'set') && transforms.getterSetter) {
			CompileError.missingTransform("getters and setters", "getterSetter", this);
		}
		super.initialise(transforms);
	}

	transpile(code, transforms) {
		super.transpile(code, transforms);

		if (
			transforms.conciseMethodProperty &&
			!this.computed &&
			this.parent.type !== 'ObjectPattern'
		) {
			if (this.shorthand) {
				code.prependRight(this.start, `${this.key.name}: `);
			} else if (this.method) {
				var name = '';
				if (this.program.options.namedFunctionExpressions !== false) {
					if (
						this.key.type === 'Literal' &&
						typeof this.key.value === 'number'
					) {
						name = '';
					} else if (this.key.type === 'Identifier') {
						if (
							reserved[this.key.name] ||
							!/^[a-z_$][a-z0-9_$]*$/i.test(this.key.name) ||
							this.value.body.scope.references[this.key.name]
						) {
							name = this.findScope(true).createIdentifier(this.key.name);
						} else {
							name = this.key.name;
						}
					} else {
						name = this.findScope(true).createIdentifier(this.key.value);
					}
					name = ' ' + name;
				}

				if (this.start < this.key.start) { code.remove(this.start, this.key.start); }
				code.appendLeft(
					this.key.end,
					`: ${this.value.async ? 'async ' : ''}function${this.value.generator ? '*' : ''}${name}`
				);
			}
		}

		if (transforms.reservedProperties && reserved[this.key.name]) {
			code.prependRight(this.key.start, `'`);
			code.appendLeft(this.key.end, `'`);
		}
	}
}

class ReturnStatement extends Node {
	initialise(transforms) {
		this.loop = this.findNearest(loopStatement);
		this.nearestFunction = this.findNearest(/Function/);

		if (
			this.loop &&
			(!this.nearestFunction || this.loop.depth > this.nearestFunction.depth)
		) {
			this.loop.canReturn = true;
			this.shouldWrap = true;
		}

		if (this.argument) { this.argument.initialise(transforms); }
	}

	transpile(code, transforms) {
		var shouldWrap =
			this.shouldWrap && this.loop && this.loop.shouldRewriteAsFunction;

		if (this.argument) {
			if (shouldWrap) { code.prependRight(this.argument.start, `{ v: `); }
			this.argument.transpile(code, transforms);
			if (shouldWrap) { code.appendLeft(this.argument.end, ` }`); }
		} else if (shouldWrap) {
			code.appendLeft(this.start + 6, ' {}');
		}
	}
}

class Super extends Node {
	initialise(transforms) {
		if (transforms.classes) {
			this.method = this.findNearest('MethodDefinition');
			if (!this.method)
				{ throw new CompileError('use of super outside class method', this); }

			var parentClass = this.findNearest('ClassBody').parent;
			this.superClassName =
				parentClass.superClass && (parentClass.superClass.name || 'superclass');

			if (!this.superClassName)
				{ throw new CompileError('super used in base class', this); }

			this.isCalled =
				this.parent.type === 'CallExpression' && this === this.parent.callee;

			if (this.method.kind !== 'constructor' && this.isCalled) {
				throw new CompileError(
					'super() not allowed outside class constructor',
					this
				);
			}

			this.isMember = this.parent.type === 'MemberExpression';

			if (!this.isCalled && !this.isMember) {
				throw new CompileError(
					'Unexpected use of `super` (expected `super(...)` or `super.*`)',
					this
				);
			}
		}

		if (transforms.arrow) {
			var lexicalBoundary = this.findLexicalBoundary();
			var arrowFunction = this.findNearest('ArrowFunctionExpression');
			var loop = this.findNearest(loopStatement);

			if (arrowFunction && arrowFunction.depth > lexicalBoundary.depth) {
				this.thisAlias = lexicalBoundary.getThisAlias();
			}

			if (
				loop &&
				loop.body.contains(this) &&
				loop.depth > lexicalBoundary.depth
			) {
				this.thisAlias = lexicalBoundary.getThisAlias();
			}
		}
	}

	transpile(code, transforms) {
		if (transforms.classes) {
			var expression =
				this.isCalled || this.method.static
					? this.superClassName
					: `${this.superClassName}.prototype`;

			code.overwrite(this.start, this.end, expression, {
				storeName: true,
				contentOnly: true
			});

			var callExpression = this.isCalled ? this.parent : this.parent.parent;

			if (callExpression && callExpression.type === 'CallExpression') {
				if (!this.noCall) {
					// special case ??? `super( ...args )`
					code.appendLeft(callExpression.callee.end, '.call');
				}

				var thisAlias = this.thisAlias || 'this';

				if (callExpression.arguments.length) {
					code.appendLeft(callExpression.arguments[0].start, `${thisAlias}, `);
				} else {
					code.appendLeft(callExpression.end - 1, `${thisAlias}`);
				}
			}
		}
	}
}

class TaggedTemplateExpression extends Node {
	initialise(transforms) {
		if (
			transforms.templateString &&
			!transforms.dangerousTaggedTemplateString
		) {
			CompileError.missingTransform(
				"tagged template strings", "templateString", this, "dangerousTaggedTemplateString"
			);
		}

		super.initialise(transforms);
	}

	transpile(code, transforms) {
		if (transforms.templateString && transforms.dangerousTaggedTemplateString) {
			var ordered = this.quasi.expressions
				.concat(this.quasi.quasis)
				.sort((a, b) => a.start - b.start);

			var program = this.program;
			var rootScope = program.body.scope;

			// insert strings at start
			var templateStrings = this.quasi.quasis.map(quasi =>
				JSON.stringify(quasi.value.cooked)
			).join(', ');

			var templateObject = this.program.templateLiteralQuasis[templateStrings];
			if (!templateObject) {
				templateObject = rootScope.createIdentifier('templateObject');
				code.prependLeft(this.program.prependAt, `var ${templateObject} = Object.freeze([${templateStrings}]);\n`);

				this.program.templateLiteralQuasis[templateStrings] = templateObject;
			}

			code.overwrite(
				this.tag.end,
				ordered[0].start,
				`(${templateObject}`
			);

			var lastIndex = ordered[0].start;
			ordered.forEach(node => {
				if (node.type === 'TemplateElement') {
					code.remove(lastIndex, node.end);
				} else {
					code.overwrite(lastIndex, node.start, ', ');
				}

				lastIndex = node.end;
			});

			code.overwrite(lastIndex, this.end, ')');
		}

		super.transpile(code, transforms);
	}
}

class TemplateElement extends Node {
	initialise() {
		this.program.indentExclusionElements.push(this);
	}
}

class TemplateLiteral extends Node {
	transpile(code, transforms) {
		super.transpile(code, transforms);

		if (
			transforms.templateString &&
			this.parent.type !== 'TaggedTemplateExpression'
		) {
			var ordered = this.expressions
				.concat(this.quasis)
				.sort((a, b) => a.start - b.start || a.end - b.end)
				.filter((node, i) => {
					// include all expressions
					if (node.type !== 'TemplateElement') { return true; }

					// include all non-empty strings
					if (node.value.raw) { return true; }

					// exclude all empty strings not at the head
					return !i;
				});

			// special case ??? we may be able to skip the first element,
			// if it's the empty string, but only if the second and
			// third elements aren't both expressions (since they maybe
			// be numeric, and `1 + 2 + '3' === '33'`)
			if (ordered.length >= 3) {
				var first = ordered[0];
				var third = ordered[2];
				if (
					first.type === 'TemplateElement' &&
					first.value.raw === '' &&
					third.type === 'TemplateElement'
				) {
					ordered.shift();
				}
			}

			var parenthesise =
				(this.quasis.length !== 1 || this.expressions.length !== 0) &&
				this.parent.type !== 'TemplateLiteral' &&
				this.parent.type !== 'AssignmentExpression' &&
				this.parent.type !== 'AssignmentPattern' &&
				this.parent.type !== 'VariableDeclarator' &&
				(this.parent.type !== 'BinaryExpression' ||
					this.parent.operator !== '+');

			if (parenthesise) { code.appendRight(this.start, '('); }

			var lastIndex = this.start;

			ordered.forEach((node, i) => {
				var prefix = i === 0 ? (parenthesise ? '(' : '') : ' + ';

				if (node.type === 'TemplateElement') {
					code.overwrite(
						lastIndex,
						node.end,
						prefix + JSON.stringify(node.value.cooked)
					);
				} else {
					var parenthesise$1 = node.type !== 'Identifier'; // TODO other cases where it's safe

					if (parenthesise$1) { prefix += '('; }

					code.remove(lastIndex, node.start);

					if (prefix) { code.prependRight(node.start, prefix); }
					if (parenthesise$1) { code.appendLeft(node.end, ')'); }
				}

				lastIndex = node.end;
			});

			if (parenthesise) { code.appendLeft(lastIndex, ')'); }
			code.overwrite(lastIndex, this.end, "", { contentOnly: true });
		}
	}
}

class ThisExpression extends Node {
	initialise(transforms) {
		var lexicalBoundary = this.findLexicalBoundary();

		if (transforms.letConst) {
			// save all loops up to the lexical boundary in case we need
			// to alias them later for block-scoped declarations
			var node = this.findNearest(loopStatement);
			while (node && node.depth > lexicalBoundary.depth) {
				node.thisRefs.push(this);
				node = node.parent.findNearest(loopStatement);
			}
		}

		if (transforms.arrow) {
			var arrowFunction = this.findNearest('ArrowFunctionExpression');

			if (arrowFunction && arrowFunction.depth > lexicalBoundary.depth) {
				this.alias = lexicalBoundary.getThisAlias();
			}
		}
	}

	transpile(code) {
		if (this.alias) {
			code.overwrite(this.start, this.end, this.alias, {
				storeName: true,
				contentOnly: true
			});
		}
	}
}

class UpdateExpression extends Node {
	initialise(transforms) {
		if (this.argument.type === 'Identifier') {
			var declaration = this.findScope(false).findDeclaration(
				this.argument.name
			);
			// special case ??? https://gitlab.com/Rich-Harris/buble/issues/150
			var statement = declaration && declaration.node.ancestor(3);
			if (
				statement &&
				statement.type === 'ForStatement' &&
				statement.body.contains(this)
			) {
				statement.reassigned[this.argument.name] = true;
			}
		}

		super.initialise(transforms);
	}

	transpile(code, transforms) {
		if (this.argument.type === 'Identifier') {
			// Do this check after everything has been initialized to find
			// shadowing declarations after this expression
			checkConst(this.argument, this.findScope(false));
		}
		super.transpile(code, transforms);
	}
}

class VariableDeclaration extends Node {
	initialise(transforms) {
		this.scope = this.findScope(this.kind === 'var');
		this.declarations.forEach(declarator => declarator.initialise(transforms));
	}

	transpile(code, transforms) {
		var i0 = this.getIndentation();
		var kind = this.kind;

		if (transforms.letConst && kind !== 'var') {
			kind = 'var';
			code.overwrite(this.start, this.start + this.kind.length, kind, {
				contentOnly: true,
				storeName: true
			});
		}

		if (transforms.destructuring && this.parent.type !== 'ForOfStatement' && this.parent.type !== 'ForInStatement') {
			var c = this.start;
			var lastDeclaratorIsPattern;

			this.declarations.forEach((declarator, i) => {
				declarator.transpile(code, transforms);

				if (declarator.id.type === 'Identifier') {
					if (i > 0 && this.declarations[i - 1].id.type !== 'Identifier') {
						code.overwrite(c, declarator.id.start, `var `);
					}
				} else {
					var inline = loopStatement.test(this.parent.type);

					if (i === 0) {
						code.remove(c, declarator.id.start);
					} else {
						code.overwrite(c, declarator.id.start, `;\n${i0}`);
					}

					var simple =
						declarator.init.type === 'Identifier' && !declarator.init.rewritten;

					var name = simple
						? (declarator.init.alias || declarator.init.name)
						: declarator.findScope(true).createIdentifier('ref');

					c = declarator.start;

					var statementGenerators = [];

					if (simple) {
						code.remove(declarator.id.end, declarator.end);
					} else {
						statementGenerators.push((start, prefix, suffix) => {
							code.prependRight(declarator.id.end, `var ${name}`);
							code.appendLeft(declarator.init.end, `${suffix}`);
							code.move(declarator.id.end, declarator.end, start);
						});
					}

					var scope = declarator.findScope(false);
					destructure(
						code,
						id => scope.createIdentifier(id),
						(ref) => {
							var name = ref.name;

							return scope.resolveName(name);
					},
						declarator.id,
						name,
						inline,
						statementGenerators
					);

					var prefix = inline ? 'var ' : '';
					var suffix = inline ? `, ` : `;\n${i0}`;
					statementGenerators.forEach((fn, j) => {
						if (
							i === this.declarations.length - 1 &&
							j === statementGenerators.length - 1
						) {
							suffix = inline ? '' : ';';
						}

						fn(declarator.start, j === 0 ? prefix : '', suffix);
					});
				}

				c = declarator.end;
				lastDeclaratorIsPattern = declarator.id.type !== 'Identifier';
			});

			if (lastDeclaratorIsPattern && this.end > c) {
				code.overwrite(c, this.end, '', { contentOnly: true });
			}
		} else {
			this.declarations.forEach(declarator => {
				declarator.transpile(code, transforms);
			});
		}
	}
}

class VariableDeclarator extends Node {
	initialise(transforms) {
		var kind = this.parent.kind;
		if (kind === 'let' && this.parent.parent.type === 'ForStatement') {
			kind = 'for.let'; // special case...
		}

		this.parent.scope.addDeclaration(this.id, kind);
		super.initialise(transforms);
	}

	transpile(code, transforms) {
		if (!this.init && transforms.letConst && this.parent.kind !== 'var') {
			var inLoop = this.findNearest(
				/Function|^For(In|Of)?Statement|^(?:Do)?WhileStatement/
			);
			if (
				inLoop &&
				!/Function/.test(inLoop.type) &&
				!this.isLeftDeclaratorOfLoop()
			) {
				code.appendLeft(this.id.end, ' = (void 0)');
			}
		}

		if (this.id) { this.id.transpile(code, transforms); }
		if (this.init) { this.init.transpile(code, transforms); }
	}

	isLeftDeclaratorOfLoop() {
		return (
			this.parent &&
			this.parent.type === 'VariableDeclaration' &&
			this.parent.parent &&
			(this.parent.parent.type === 'ForInStatement' ||
				this.parent.parent.type === 'ForOfStatement') &&
			this.parent.parent.left &&
			this.parent.parent.left.declarations[0] === this
		);
	}
}

var types = {
	ArrayExpression,
	ArrowFunctionExpression,
	AssignmentExpression,
	AwaitExpression,
	BinaryExpression,
	BreakStatement,
	CallExpression,
	CatchClause,
	ClassBody,
	ClassDeclaration,
	ClassExpression,
	ContinueStatement,
	DoWhileStatement: LoopStatement,
	ExportNamedDeclaration,
	ExportDefaultDeclaration,
	ForStatement,
	ForInStatement,
	ForOfStatement,
	FunctionDeclaration,
	FunctionExpression,
	Identifier,
	IfStatement,
	Import,
	ImportDeclaration,
	ImportDefaultSpecifier,
	ImportSpecifier,
	JSXAttribute,
	JSXClosingElement,
	JSXClosingFragment,
	JSXElement,
	JSXExpressionContainer,
	JSXFragment,
	JSXOpeningElement,
	JSXOpeningFragment,
	JSXSpreadAttribute,
	Literal,
	MemberExpression,
	NewExpression,
	ObjectExpression,
	Property,
	ReturnStatement,
	Super,
	TaggedTemplateExpression,
	TemplateElement,
	TemplateLiteral,
	ThisExpression,
	UpdateExpression,
	VariableDeclaration,
	VariableDeclarator,
	WhileStatement: LoopStatement
};

var keys = {
	Program: ['body'],
	Literal: []
};

var statementsWithBlocks = {
	IfStatement: 'consequent',
	ForStatement: 'body',
	ForInStatement: 'body',
	ForOfStatement: 'body',
	WhileStatement: 'body',
	DoWhileStatement: 'body',
	ArrowFunctionExpression: 'body'
};

function wrap(raw, parent) {
	if (!raw) { return; }

	if ('length' in raw) {
		var i = raw.length;
		while (i--) { wrap(raw[i], parent); }
		return;
	}

	// with e.g. shorthand properties, key and value are
	// the same node. We don't want to wrap an object twice
	if (raw.__wrapped) { return; }
	raw.__wrapped = true;

	if (!keys[raw.type]) {
		keys[raw.type] = Object.keys(raw).filter(
			key => typeof raw[key] === 'object'
		);
	}

	// special case ??? body-less if/for/while statements. TODO others?
	var bodyType = statementsWithBlocks[raw.type];
	if (bodyType && raw[bodyType].type !== 'BlockStatement') {
		var expression = raw[bodyType];

		// create a synthetic block statement, otherwise all hell
		// breaks loose when it comes to block scoping
		raw[bodyType] = {
			start: expression.start,
			end: expression.end,
			type: 'BlockStatement',
			body: [expression],
			synthetic: true
		};
	}

	raw.parent = parent;
	raw.program = parent.program || parent;
	raw.depth = parent.depth + 1;
	raw.keys = keys[raw.type];
	raw.indentation = undefined;

	for (var i$1 = 0, list = keys[raw.type]; i$1 < list.length; i$1 += 1) {
		var key = list[i$1];

		wrap(raw[key], raw);
	}

	raw.program.magicString.addSourcemapLocation(raw.start);
	raw.program.magicString.addSourcemapLocation(raw.end);

	var type =
		(raw.type === 'BlockStatement' ? BlockStatement : types[raw.type]) || Node;
	raw.__proto__ = type.prototype;
}

function Program(source, ast, transforms, options) {
	this.type = 'Root';

	// options
	this.jsx = options.jsx || 'React.createElement';
	this.jsxFragment = options.jsxFragment || 'React.Fragment';
	this.options = options;

	this.source = source;
	this.magicString = new MagicString(source);

	this.ast = ast;
	this.depth = 0;

	wrap((this.body = ast), this);
	this.body.__proto__ = BlockStatement.prototype;

	this.templateLiteralQuasis = Object.create(null);
	for (var i = 0; i < this.body.body.length; ++i) {
		if (!this.body.body[i].directive) {
			this.prependAt = this.body.body[i].start;
			break;
		}
	}
	this.objectWithoutPropertiesHelper = null;

	this.indentExclusionElements = [];
	this.body.initialise(transforms);

	this.indentExclusions = Object.create(null);
	for (var i$2 = 0, list = this.indentExclusionElements; i$2 < list.length; i$2 += 1) {
		var node = list[i$2];

		for (var i$1 = node.start; i$1 < node.end; i$1 += 1) {
			this.indentExclusions[i$1] = true;
		}
	}

	this.body.transpile(this.magicString, transforms);
}

Program.prototype = {
	export(options) {
		if ( options === void 0 ) options = {};

		return {
			code: this.magicString.toString(),
			map: this.magicString.generateMap({
				file: options.file,
				source: options.source,
				includeContent: options.includeContent !== false
			})
		};
	},

	findNearest() {
		return null;
	},

	findScope() {
		return null;
	},

	getObjectWithoutPropertiesHelper(code) {
		if (!this.objectWithoutPropertiesHelper) {
			this.objectWithoutPropertiesHelper = this.body.scope.createIdentifier('objectWithoutProperties');
			code.prependLeft(this.prependAt, `function ${this.objectWithoutPropertiesHelper} (obj, exclude) { ` +
				`var target = {}; for (var k in obj) ` +
				`if (Object.prototype.hasOwnProperty.call(obj, k) && exclude.indexOf(k) === -1) ` +
				`target[k] = obj[k]; return target; }\n`
			);
		}
		return this.objectWithoutPropertiesHelper;
	}
};

var matrix = {
	chrome: {
		    48: 0b00010010101000110011111,
		    49: 0b00010011111001111111111,
		    50: 0b00010111111001111111111,
		    51: 0b00010111111001111111111,
		    52: 0b00011111111001111111111,
		    53: 0b00011111111001111111111,
		    54: 0b00011111111001111111111,
		    55: 0b01011111111001111111111,
		    56: 0b01011111111001111111111,
		    57: 0b01011111111001111111111,
		    58: 0b01111111111001111111111,
		    59: 0b01111111111001111111111,
		    60: 0b11111111111001111111111,
		    61: 0b11111111111001111111111,
		    62: 0b11111111111001111111111,
		    63: 0b11111111111001111111111,
		    64: 0b11111111111001111111111,
		    65: 0b11111111111001111111111,
		    66: 0b11111111111001111111111,
		    67: 0b11111111111001111111111,
		    68: 0b11111111111001111111111,
		    69: 0b11111111111001111111111,
		    70: 0b11111111111001111111111,
		    71: 0b11111111111001111111111
	},
	firefox: {
		    43: 0b00010011101000110111011,
		    44: 0b00010011101000110111011,
		    45: 0b00010011101000110111111,
		    46: 0b00010111101000110111111,
		    47: 0b00010111101000111111111,
		    48: 0b00010111101000111111111,
		    49: 0b00010111101000111111111,
		    50: 0b00010111101000111111111,
		    51: 0b00010111101001111111111,
		    52: 0b01111111111001111111111,
		    53: 0b01111111111001111111111,
		    54: 0b01111111111001111111111,
		    55: 0b11111111111001111111111,
		    56: 0b11111111111001111111111,
		    57: 0b11111111111001111111111,
		    58: 0b11111111111001111111111,
		    59: 0b11111111111001111111111,
		    60: 0b11111111111001111111111,
		    61: 0b11111111111001111111111,
		    62: 0b11111111111001111111111,
		    63: 0b11111111111001111111111,
		    64: 0b11111111111001111111111
	},
	safari: {
		     8: 0b00010000000000000001001,
		     9: 0b00010010001000011011101,
		    10: 0b00110111111001111111111,
		'10.1': 0b01111111111001111111111,
		    11: 0b01111111111001111111111,
		'11.1': 0b11111111111001111111111,
		    12: 0b11111111111001111111111
	},
	ie: {
		     8: 0b00000000000000000000000,
		     9: 0b00010000000000000000001,
		    10: 0b00010000000000000000001,
		    11: 0b00010000000000000000001 // no let/const in for loops
	},
	edge: {
		    12: 0b00010010101000010011011,
		    13: 0b00010111101000110011111,
		    14: 0b00111111101001111111111,
		    15: 0b01111111101001111111111,
		    16: 0b01111111101001111111111,
		    17: 0b01111111101001111111111,
		    18: 0b01111111101001111111111,
		    19: 0b01111111101001111111111
	},
	node: {
		'0.10': 0b00010000000000000000001,
		'0.12': 0b00010000000000010000001,
		     4: 0b00010010001000110011111,
		     5: 0b00010010001000110011111,
		     6: 0b00010111111001111111111,
		     8: 0b01111111111001111111111,
		 '8.3': 0b11111111111001111111111,
		 '8.7': 0b11111111111001111111111,
		'8.10': 0b11111111111001111111111
	}
};

var features = [
	'getterSetter',
	'arrow',
	'classes',
	'computedProperty',
	'conciseMethodProperty',
	'defaultParameter',
	'destructuring',
	'forOf',
	'generator',
	'letConst',
	'moduleExport',
	'moduleImport',
	'numericLiteral',
	'parameterDestructuring',
	'spreadRest',
	'stickyRegExp',
	'templateString',
	'unicodeRegExp',

	// ES2016
	'exponentiation',

	// additional transforms, not from
	// https://featuretests.io
	'reservedProperties',

	'trailingFunctionCommas',
	'asyncAwait',
	'objectRestSpread'
];

var version = "0.20.0";

var parser = Parser;

var dangerousTransforms = ['dangerousTaggedTemplateString', 'dangerousForOf'];

function target(target) {
	var targets = Object.keys(target);
	var bitmask = targets.length
		? 0b11111111111111111111111
		: 0b00010000000000000000001;

	Object.keys(target).forEach(environment => {
		var versions = matrix[environment];
		if (!versions)
			{ throw new Error(
				`Unknown environment '${environment}'. Please raise an issue at https://github.com/bublejs/buble/issues`
			); }

		var targetVersion = target[environment];
		if (!(targetVersion in versions))
			{ throw new Error(
				`Support data exists for the following versions of ${environment}: ${Object.keys(
					versions
				).join(
					', '
				)}. Please raise an issue at https://github.com/bublejs/buble/issues`
			); }
		var support = versions[targetVersion];

		bitmask &= support;
	});

	var transforms = Object.create(null);
	features.forEach((name, i) => {
		transforms[name] = !(bitmask & (1 << i));
	});

	dangerousTransforms.forEach(name => {
		transforms[name] = false;
	});

	return transforms;
}

function transform(source, options) {
	if ( options === void 0 ) options = {};

	var ast;
	var jsx = null;

	try {
		ast = parser.parse(source, {
			ecmaVersion: 'latest',
			preserveParens: true,
			sourceType: 'module',
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowHashBang: true,
			onComment: (block, text) => {
				if (!jsx) {
					var match = /@jsx\s+([^\s]+)/.exec(text);
					if (match) { jsx = match[1]; }
				}
			}
		});
		options.jsx = jsx || options.jsx;
	} catch (err) {
		err.snippet = getSnippet(source, err.loc);
		err.toString = () => `${err.name}: ${err.message}\n${err.snippet}`;
		throw err;
	}

	var transforms = target(options.target || {});
	Object.keys(options.transforms || {}).forEach(name => {
		if (name === 'modules') {
			if (!('moduleImport' in options.transforms))
				{ transforms.moduleImport = options.transforms.modules; }
			if (!('moduleExport' in options.transforms))
				{ transforms.moduleExport = options.transforms.modules; }
			return;
		}

		if (!(name in transforms)) { throw new Error(`Unknown transform '${name}'`); }
		transforms[name] = options.transforms[name];
	});
	if (options.objectAssign === true) { options.objectAssign = 'Object.assign'; }
	return new Program(source, ast, transforms, options).export(options);
}

export { version as VERSION, target, transform };
//# sourceMappingURL=buble.es.js.map
