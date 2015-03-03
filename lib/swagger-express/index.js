var _ = require('underscore');
var async = require('async');
var fs = require('fs');
var node_path = require('path');
var yaml = require('js-yaml');
var coffee = require('coffee-script');
var url = require('url');

var doctrine = require('doctrine');
var express = require('express');
var ms = require('mongoose-schema');

var descriptor = {};
var paths = {};
var definitions = {};

/**
 * Read from yml file
 * @api    private
 * @param  {String}   file
 * @param  {Function} fn
 */
function readYml(file, fn) {
   var resource = require(node_path.resolve(process.cwd(), file));
   readDoc(resource);
   fn();
}

/**
 * Helper function to parse docs
 * @api    private
 * @param  {Array}   fragments
 * @param  {Function} fn
 */
function parseDocs(fragments, fn) {
   var docs = [];
   if (!fragments) return fn(null, docs);

   for (var i = 0; i < fragments.length; i++) {
      var fragment = fragments[i];
      var doc = doctrine.parse(fragment, { unwrap: true });

      docs.push(doc);

      if (i === fragments.length - 1) {
         fn(null, docs);
      }
   }
};

/**
 * Parse jsDoc from a js file
 * @api    private
 * @param  {String}   file
 * @param  {Function} fn
 */
function parseJsDocs(file, fn) {
   fs.readFile(file, function (err, data) {
      if (err) return fn(err);

      var js = data.toString();
      var regex = /\/\*\*([\s\S]*?)\*\//gm;
      parseDocs(js.match(regex), fn);
   });
}

/**
 * Parse coffeeDoc from a coffee file
 * @api    private
 * @param  {String}   file
 * @param  {Function} fn
 */
function parseCoffeeDocs(file, fn) {
   fs.readFile(file, function (err, data) {
      if (err) return fn(err);

      var js = coffee.compile(data.toString());
      var regex = /\/\**([\s\S]*?)\*\//gm;
      parseDocs(js.match(regex), fn)
   });
}

/**
 * Get jsDoc tag with title '@swagger'
 * @api    private
 * @param  {Object} fragment
 * @param  {Function} fn
 */
function getSwagger(fragment, fn) {
   for (var i = 0; i < fragment.tags.length; i++) {
      var tag = fragment.tags[i];
      if ('swagger' === tag.title) {
         return yaml.safeLoadAll(tag.description, fn);
      }
   }

   return fn(false);
}

/**
 * Helper function to read doc
 * @api    private
 * @param  {Object}  path
 */
function readDoc(path) {
   Object.keys(path).forEach(function(path_name) {
      Object.keys(path[path_name]).forEach(function(path_method) {
         paths[path_name][path_method] = path[path_name][path_method]
      })
   })
}

/**
 * Read from jsDoc
 * @api    private
 * @param  {String}  file
 * @param  {Function} fn
 */
function readJsDoc(file, fn) {
   parseJsDocs(file, function (err, docs) {
      if (err) return fn(err);

      async.eachSeries(docs, function (doc, cb) {
         getSwagger(doc, function (path) {
            if (!path) return cb();
            readDoc(path);
            cb();
         });
      }, function (err) {
         fn();
      });
   });
}

function convertPath(path) {
   return path.replace(/:([a-zA-Z_]+)/g, "{$1}")
}

/**
 * Read from coffeeDoc
 * @api    private
 * @param  {String}  file
 * @param  {Function} fn
 */
function readCoffee(file, fn) {
   parseCoffeeDocs(file, function (err, docs) {
      if (err) return fn(err);

      async.eachSeries(docs, function (doc, cb) {
         getSwagger(doc, function (path) {
            if (!path) return cb();
            readDoc(path);
            cb();
         });
      }, function (err) {
         fn();
      });
   });
}

/**
 * Read API from file
 * @api    private
 * @param  {String}   file
 * @param  {Function} fn
 */
function readApi(file, fn) {
   var ext = node_path.extname(file);
   if ('.js' === ext) {
      readJsDoc(file, fn);
   } else if ('.yml' === ext) {
      readYml(file, fn);
   } else if ('.coffee' === ext) {
      readCoffee(file, fn);
   } else {
      throw new Error('Unsupported extension \'' + ext + '\'');
   }
}

/**
 * Generate Swagger documents
 * @api    private
 * @param  {Object} opt
 */
function generate(opt) {
   if (!opt) {
      throw new Error('\'option\' is required.');
   }

   if (!opt.swaggerUI) {
      throw new Error('\'swaggerUI\' is required.');
   }

   if (!opt.basePath) {
      throw new Error('\'basePath\' is required.');
   }

   descriptor.basePath = opt.basePath;
   descriptor.swagger = (opt.swaggerVersion) ? opt.swaggerVersion : '2.0';

   if(opt.info) {
      descriptor.info = opt.info;
      descriptor.info.version = (opt.apiVersion) ? opt.apiVersion : '1.0';
   }

   if (opt.app) {
      var routes = {};
      opt.app._router.stack.forEach(function(app_routes) {
         if (app_routes.route) {
            var path = convertPath(app_routes.route.path);
            routes[path] = routes[path] || {};
            Object.keys(app_routes.route.methods).forEach(function(method) {
               routes[path][method] = {responses: {200:{}}}
            })
         }
      })
      paths = routes;
   }

   if (opt.mongoose) {
      var JsonSchemaGenerator = new ms.JsonSchemaGenerator();
      var schems = {};
      opt.mongoose.modelNames().forEach(function(name) {
         schems[name] = JsonSchemaGenerator.generate(opt.mongoose.modelSchemas[name]);
      });
      definitions = schems;
   }

   if (!opt.fullSwaggerJSONPath) {
      opt.fullSwaggerJSONPath = url.parse(opt.basePath + opt.swaggerJSON).path;
   }

   if (opt.apis) {
      opt.apis.forEach(function (api) {
         readApi(api, function (err) {
            if (err) throw err;
         });
      });
   }
}

/**
 * Express middleware
 * @api    public
 * @param  {Object} app
 * @param  {Object} opt
 * @return {Function}
 */
exports.init = function (app, opt) {

   // generate resources
   generate(opt);

   // Serve up swagger ui static assets
   var swHandler = express.static(opt.swaggerUI);

   // Serve up swagger ui interface.
   var swaggerURL = new RegExp('^'+ opt.swaggerURL +'(\/.*)?$');

   app.get(swaggerURL, function (req, res, next) {
      if (req.url === opt.swaggerURL) { // express static barfs on root url w/o trailing slash
         res.writeHead(302, { 'Location' : req.url + '/' });
         res.end();
         return;
      }

      // take off leading /swagger so that connect locates file correctly
      req.url = req.url.substr(opt.swaggerURL.length);
      return swHandler(req, res, next);
   });

   return function (req, res, next) {
      var match, resource, result;

      var regex = new RegExp('^'+ opt.fullSwaggerJSONPath +'(\/.*)?$');

      match = regex.exec(req.path);

      if (match) {
         result = _.clone(descriptor);
         if (!paths) {
            //detect if it's express 4.x or 3.5.x
            return (res.sendStatus ? res.sendStatus(404) : res.send(404));
         }
         result.paths = paths;
         result.definitions = definitions;

         if(typeof(opt.middleware) == 'function'){
            opt.middleware(req, res);
         }

         return res.json(result);
      }
      return next();
   };
};

exports.descriptor = descriptor;