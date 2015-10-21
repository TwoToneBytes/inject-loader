var loaderUtils = require("loader-utils"),
    astQuery = require('ast-query'),
    escodegen = require('escodegen');

var HAS_DYNAMIC_REQUIRE_REGEX = /require\.context\(/;

var hasOnlyExcludeFlags = function hasOnlyExcludeFlags(query) {
    return Object.keys(query).filter(function (key) {
            return query[key] === true;
        }).length === 0;
};

var escapePath = function escapePath(path) {
    return path.replace('/', '\\/')
};

var quoteRegexString = function quoteRegexString() {
    return "[\'|\"]{1}";
};

var createRequireStringRegex = function createRequireStringRegex(query) {
    var regexArray = [];

    // if there is no query then replace everything
    if (Object.keys(query).length === 0) {
        regexArray.push("([^\\)]+)")
    } else {
        // if there are only negation matches in the query then replace everything
        // except them
        if (hasOnlyExcludeFlags(query)) {
            Object.keys(query).forEach(function (key) {
                regexArray.push("(?!" + quoteRegexString() + escapePath(key) + ")")
            });
            regexArray.push("([^\\)]+)");
        } else {
            regexArray.push("(" + quoteRegexString() + "(");
            regexArray.push(Object.keys(query).map(function (key) {
                return escapePath(key);
            }).join("|"));
            regexArray.push(")" + quoteRegexString() + ")")
        }
    }

    // Wrap the regex to match `require()`
    regexArray.unshift("require\\(");
    regexArray.push("\\)");

    return new RegExp(regexArray.join(""), 'g');
};

module.exports = function inject(src) {
    this.cacheable && this.cacheable();
    var regex = createRequireStringRegex(loaderUtils.parseQuery(this.query)),
        injectedSrc = [
            'module.exports = function inject(injections) {',
            'var module = {exports: {}};',
            'var exports = module.exports;',
            src.replace(regex, "(injections[$1] || $&)"),
            'return module.exports;',
            '}'
        ].join("\n");


    if (HAS_DYNAMIC_REQUIRE_REGEX.test(src)) {
        injectedSrc = replaceRequireContextWithInjections(injectedSrc);
    }

    return injectedSrc;
};


/**
 * Replaces require.context calls with injections[dynamicModuleName]
 * @example
 * var req = require.context('./modules/', false, '.js');
 * var module = req('foo.js'); -> var module = injections['./modules/foo.js'] || req('foo.js');
 * @param {String} src
 */
function replaceRequireContextWithInjections(src) {
    var queryableAst = astQuery(src),
        allVariables = queryableAst.var(/.+/);

    var requireContextVariables = allVariables.nodes.filter(function (node) {
        var varInitializer = node.init,
            callee = varInitializer && varInitializer.type == 'CallExpression' && varInitializer.callee;

        return !!(callee
        && callee.type === 'MemberExpression'
        && callee.object.name === 'require'
        && callee.property.name === 'context');
    });

    requireContextVariables.forEach(function (varExpression) {
        var basePath = escodegen.generate(varExpression.init.arguments[0]),
            replaceIn = sourceReplacementFactory(src);

        // These are the resulting VariableExpressions that come from calling: (var req = require.context())
        // ex:
        // var req = require.context(); // req is our varExpression
        // var module1 = req('module-name.js');
        // var module2 = req('module2-name.js'); // module1 and module2 make-up the matchingCallExpressionResults
        var matchingCallExpressionResults = queryableAst.callExpression(varExpression.id.name).nodes;

        matchingCallExpressionResults.forEach(function (node) {
            var dynamicModuleName = escodegen.generate(node.arguments[0]);

            src = replaceIn(node.range[0], node.range[1], '(injections[' + basePath + ' + ' + dynamicModuleName + '] || ' + escodegen.generate(node) + ')');
        });
    });

    return src;
}

/**
 * Creates a function that replaces subtext within a larger text.
 * It keeps a counter of the text replaced so far so that it can replace substrings using the original text's offsets.
 * @param source
 * @returns {replaceIn}
 */
function sourceReplacementFactory(source) {
    var indexOffset = 0;

    return replaceIn;

    /**
     * Replaces text starting {indexFrom} to {indexTo} with {replacementText}.
     * @param indexFrom
     * @param indexTo
     * @param replacementText
     * @returns {string}
     */
    function replaceIn(indexFrom, indexTo, replacementText) {
        var actualIndexFrom = indexFrom + indexOffset,
            actualIndexTo = indexTo + indexOffset,
            originalTextLength = indexTo - indexFrom;

        // Correct the offset after every replacement:
        indexOffset = indexOffset + replacementText.length - originalTextLength;
        source = source.substr(0, actualIndexFrom) + replacementText + source.substr(actualIndexTo, source.length);

        return source;
    }
}