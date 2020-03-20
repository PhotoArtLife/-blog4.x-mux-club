const fs = require('fs')
const path = require('path')
const LRU = require('lru-cache')
const express = require('express')
const favicons = require('connect-favicons-pro')
const open = require('open')
const compression = require('compression')
const microcache = require('route-cache')
const { createBundleRenderer } = require('vue-server-renderer')
const resolve = file => path.resolve(__dirname, file)
const projectConfig = require('../package.json')

const isProd = process.env.NODE_ENV === 'production'
const useMicroCache = process.env.MICRO_CACHE !== 'false'
const serverInfo =
	`express/${ require('express/package.json').version } ` +
	`vue-server-renderer/${ require('vue-server-renderer/package.json').version }`

const app = express()

function createRenderer(bundle, options) {
	// https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
	return createBundleRenderer(bundle, Object.assign(options, {
		// for component caching
		cache: new LRU({
			max: 1000,
			maxAge: 1000 * 60 * 15
		}),
		// this is only needed when vue-server-renderer is npm-linked
		basedir: resolve('../public'),
		// recommended for performance
		runInNewContext: false
	}))
}

let renderer
let readyPromise
const templatePath = resolve('../src/index.template.html')
if (isProd) {
	// In production: create server renderer using template and built server bundle.
	// The server bundle is generated by vue-ssr-webpack-plugin.
	const template = fs.readFileSync(templatePath, 'utf-8')
	const bundle = require('../public/vue-ssr-server-bundle.json')
	// The client manifests are optional, but it allows the renderer
	// to automatically infer preload/prefetch links and directly add <script>
	// tags for any async chunks used during render, avoiding waterfall requests.
	const clientManifest = require('../public/vue-ssr-client-manifest.json')
	renderer = createRenderer(bundle, {
		template,
		clientManifest
	})
} else {
	// In development: setup the dev server with watch and hot-reload,
	// and create a new renderer on bundle / index template update.
	readyPromise = require('../build/setup-dev-server')(
		app,
		templatePath,
		(bundle, options) => {
			renderer = createRenderer(bundle, options)
		}
	)
}
// favicon
app.use(favicons(resolve('./static/icons'), {
	filenames: [
		'favicon.ico',
		'favicon-16x16.png',
		'favicon-32x32.png',
		'favicon-48x48.png'
	]
}))

const serve = (path, cache) => express.static(resolve(path), {
	maxAge: cache && isProd ? 1000 * 60 * 60 * 24 * 30 : 0
})

app.use(compression({ threshold: 0 }))
app.use('/', serve('./public', true))
app.use('/static', serve('./static', true))
app.use('/manifest.json', serve('./manifest.json', true))
// since this app has no user-specific content, every page is micro-cacheable.
// if your app involves user-specific content, you need to implement custom
// logic to determine whether a request is cacheable based on its url and
// headers.
// 1-second microcache.
// https://www.nginx.com/blog/benefits-of-microcaching-nginx/
app.use(microcache.cacheSeconds(1, req => useMicroCache && req.originalUrl))

function render(req, res) {
	const s = Date.now()

	res.setHeader("Content-Type", "text/html")
	res.setHeader("Server", serverInfo)

	const handleError = err => {
		if (err.url) {
			res.redirect(err.url)
		} else if (err.code === 404) {
			res.status(404).send('404 | Page Not Found')
		} else {
			// Render Error Page or Redirect
			res.status(500).send('500 | Internal Server Error')
			console.error(`error during render : ${ req.url }`)
			console.error(err.stack)
		}
	}

	const context = {
		title: projectConfig.description, // default title
		url: req.url
	}
	renderer.renderToString(context, (err, html) => {
		if (err) {
			return handleError(err)
		}
		res.send(html)
		if (!isProd) {
			console.log(`whole request: ${ Date.now() - s }ms`)
		}
	})
}

app.get('*', isProd ? render : (req, res) => {
	readyPromise.then(() => render(req, res))
})

const port = process.env.PORT || 8080
app.listen(port, () => {
	console.log(`server started at localhost:${ port }`)
	open(`http://localhost:${ port }`)
})