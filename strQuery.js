const builtIn = require('./builtin'),
	tools = require('./tools');

const ops = [
	{'!' : (p)=>!p},
	{'*' : (p1,p2)=>p1*p2},
	{"/" : (p1,p2)=>p1/p2},
	{"%" : (p1,p2)=>p1%p2},
	{'+' : (p1,p2)=>p1+p2},
	{'-' : (p1,p2)=>p1-p2},
	{'<='  : (p1,p2)=>p1<=p2},
	{'>=' : (p1,p2)=>p1<=p2},
	{'!=' : (p1,p2)=>p1!=p2},
	{'=' : (p1,p2)=>p1==p2},
	{'<' : (p1,p2)=>p1<p2},
	{'>' : (p1,p2)=>p1<p2},
	{'||' : (p1,p2)=>p1||p2},
	{'&&' : (p1,p2)=>p1||p2}
];
const specialCharacters = "\\!\\*\\/\\%\\+\\-\\<\\>\\=";

function handleQuery(query, buffer, getResourceFunction) {
	var response = {},
		promise = Promise.resolve(response);
	query = query.replace(/\"([^"]+)\"|\'([^']+)\'|(true)|(false)/g, (m, str)=>{ //save strings and Booleans
		buffer.anonymous.push({"true":true, "false":false}[str] || str);
		return '$anonymous'+(buffer.anonymous.length-1)
	}).replace(/\s+/g,'');
	while(~query.indexOf('(')) //execute brackets
		query.replace(/\(([^\(\)])\)/g, (m, body)=>{
			buffer.anonymous.push(handleQuery(body, buffer, getResourceFunction, promise));
			return '$anonymous'+buffer.lenfth-1;
		});
	query = query.split(';');
	for(let i = 0; i < query.length; i++){
		promise = promise.then((resp)=>{
			return handleExpression(query[i], buffer, getResourceFunction).then((exprResult)=>{
				for(let key in exprResult){
					response[key] = exprResult[key];
				}
				return response;
			});
		});
	}
	return promise;
}

function handleExpression(expr, buffer, getResourceFunction){
	let decomposed = (""+expr).match(/^(?:(\w+)\=)?(?:(\w+)\?)?([\S\s]+)?$/),
		resolvedParams = [],
		paramsPromise = Promise.resolve(resolvedParams);
	if(decomposed[3]) {
		decomposed[3] = decomposed[3].replace(/(?:^|\&)([a-zA-Z]+(?:\?[\S\s]+)?)/g, (m, body)=>{ //handle function calls in params
			buffer.anonymous.push(handleExpression(body, buffer, getResourceFunction));
			return '$anonymous'+buffer.anonymous.lenfth-1
		});
		var params = decomposed[3].split(",");
		for(let i = 0; i < params.length; i++){
			paramsPromise = paramsPromise.then((resolvedParams)=>{
				return runOperator(params[i], buffer)
			}).then((r)=>{
				resolvedParams.push(r);
				return resolvedParams;
			});
		}
	}
	if(decomposed[2]){
		return paramsPromise.then((params)=>{
			var result = getResourceFunction(decomposed[2], params, expr).apply(null, params);
			buffer[decomposed[1] || decomposed[2]] = result;
			return {[decomposed[1] || decomposed[2]] : result};
		});
	}
	else {
		return paramsPromise;
	}
}
function runOperator(operator, buffer){
	function resolveDataType(p){
		if(/^\d+$/.test(p)) return +p;
	};
	return resolveParams(operator).then(()=>{
		//console.log(operator);
		for(let i=0; i < ops.length; i++){
			for(let key in ops[i]) {
				if(ops[i][key].length == 1){
					operator = operator.replace(new RegExp(key.replace(/(\S)/g, '\\$1')+'([^'+specialCharacters+'])'+'+','g'), (match, p)=>{
						buffer.anonymous.push(ops[key](p));
						return '$anonymous'+(buffer.anonymous.length-1);
					});
				}
				else {
					operator = operator.replace(new RegExp('([^'+specialCharacters+'])'+key.replace(/(\S)/g, '\\$1')+'([^'+specialCharacters+'])'+'+','g'), (match, p1, p2)=>{
						buffer.anonymous.push(ops[i][key](+p1, +p2));
						return '$anonymous'+(buffer.anonymous.length-1);
					});
				}
			}
		}
		return operator[0] == "$" ? buffer.anonymous[+operator.substr(10)] : +operator;
	});
//TODO: solve number parameters issue
}
var resolveParams  = (()=>{
	var callbacks,
		subscribe = (keys, cb)=>{
			callbacks[keys.sort().join('|')];
		};
	return (operator, buffer)=>{
		var params = (""+operator).match(/\$w+/g);
		for(let key in params){
			if(!buffer[params.key])
				return new Promise((resolve)=>{
					subscribe(params, resolve)
				})
		}
		return Promise.resolve();
	}
})();


var sharedResourceMethods;
class LiteQL{
	constructor(options){
		options = options || {};
		this.resources = options.resources || {};
		this.resourceMethod = options.resourceMethod;
		this.cache = {};
		this.delegatedBuiltin = options.delegatedBuiltin || [];
		this.scope = {};
	}
	addResources(resources){
		Object.assign(this.resources, resources);
		return this;
	}
	call(query){
		var obj = {},
			buffer = {
				anonymous : []
			},
			promise = Promise.resolve(obj),
			deferred = [],
			delegated = [],
			resourceMethod = this.resourceMethod,
			resources = this.resources,
			cache = this.cache,
			delegatedBuiltin = this.delegatedBuiltin,
			scope = this.scope,
			context = {};
		context.currentQuery = query;
		context.promise = promise;
		context.handleQuery = handleQuery;
		context.getResourceFunction = getResourceFunction;
		function getResourceFunction(queryMethod, params, subQuery){
			var key = queryMethod,
				cacheEntryPoint = cache[key+JSON.stringify(params)];
			if(cacheEntryPoint) {
				let result;
				if(!cacheEntryPoint.expiration || cacheEntryPoint.expiration > (new Date()).getTime()){
					result = cacheEntryPoint.val;
					cacheEntryPoint.singleServe && (delete cache[key+JSON.stringify(params)])
				}
				else {
					delete cache[key+JSON.stringify(params)];
				}
				if(result) {
					return ()=>result;
				}
			}
			var method = resources[key] || (resourceMethod ? resourceMethod(key) : (sharedResourceMethods && sharedResourceMethods(key)));
			if((!method && (~delegatedBuiltin.indexOf(key) || !queryMethod.builtIn)) || queryMethod.delegated) {
				delegated.push(subQuery);
				return ()=>"__delagated__";
			}

			if(~JSON.stringify(params).indexOf('__failed__')){
				deferred.push(subQuery);
				return ()=>null;
			}
			if(queryMethod.builtIn) {
				return builtIn[key];
			}
			return method;
		}
		promise = handleQuery(query, buffer, getResourceFunction).then((response)=>{
			if(Object.keys(response).length == 1) for(let key in response){
				return response[key];
			}
			return response;
		});
		if(resources.__delegate__){
			promise = promise.then((obj)=>{
				if(delegated.length) {
					return resources.__delegate__(delegated.join(';').replace(/\$([a-zA-Z0-9]+)/, (match, key)=>{
						var val = (/anonymous\d+/).test(key) ? buffer.anonymous[key.match(/\d+/)[0]] :  buffer[key];
						return typeof val == "string" ? '"'+val+'"' : val;
					})).then((resp)=>{
						if(delegated.length == 1){
							let key = delegated[0].match(/^(\w+)\?/)[1];
							resp = {[key]:resp};
						}
						Object.assign(buffer, resp);
						if(obj) {
							Object.assign(obj, resp);
						} else {
							obj = resp;
						}

						return obj;
					})
				}
				else {return obj}
			})
		}
		return promise

	}
	setResourceMethod(method){
		resourceMethod = method;
		return this;
	}
	static setResourceMethod(method){
		sharedResourceMethods = method;
	}
}
module.exports = LiteQL;