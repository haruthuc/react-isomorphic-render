// Makes @preload() decorator work.
// (preloads data required for displaying a page before actually navigating to it)

import deep_equal from 'deep-equal'
import getRouteParams from 'react-router/lib/getRouteParams'

import { location_url } from '../../location'
import { server_redirect } from '../../history'
import { Preload, Redirect, GoTo, redirect_action, goto_action, history_redirect_action, history_goto_action } from '../actions'
import match_routes_against_location from '../../react-router/match'
import get_route_path from '../../react-router/get route path'

export const Preload_method_name  = '__preload__'
export const Preload_options_name = '__preload_options__'

export const Preload_started  = '@@react-isomorphic-render/redux/preload started'
export const Preload_finished = '@@react-isomorphic-render/redux/preload finished'
export const Preload_failed   = '@@react-isomorphic-render/redux/preload failed'

export default function preloading_middleware(server, error_handler, preload_helpers, routes, get_history, report_stats, on_navigate)
{
	return ({ getState, dispatch }) => next => action =>
	{
		// Handle only `Preload` actions
		if (action.type !== Preload)
		{
			// Do nothing
			return next(action)
		}

		// A special flavour of `dispatch` which `throw`s for redirects on the server side.
		dispatch = preloading_middleware_dispatch(dispatch, server)

		// Navigation event triggered
		if (on_navigate && !action.initial)
		{
			on_navigate(location_url(action.location))
		}

		// Preload status object.
		// `preloading` holds the cancellation flag for this navigation process.
		// (e.g. preloading `Promise` chain could be cancelled in case of a redirect)
		const preloading = {}

		// Can cancel previous preloading (on the client side)
		let previous_preloading
		if (!server)
		{
			previous_preloading = window.__preloading_page
			window.__preloading_page = preloading
		}

		function preload_finished(time, route)
		{
			preloading.pending = false
			// preloading.time = time

			// This preloading time will be longer then
			// the server-side one, say, by 10 milliseconds, 
			// probably because the web browser making
			// an asynchronous HTTP request is slower
			// than the Node.js server making a regular HTTP request.
			// Also this includes network latency
			// for a particular website user, etc.
			// So this `preload` time doesn't actually describe
			// the server-side performance.
			if (report_stats)
			{
				report_stats
				({
					url : location_url(action.location),
					route,
					time:
					{
						preload: time
					}
				})
			}
		}

		function preload_failed(error)
		{
			preloading.pending = false
			// preloading.error = error
		}

		function preload_cancelled()
		{
			preloading.pending = false
		}

		return match_routes_against_location
		({
			routes   : typeof routes === 'function' ? routes({ dispatch, getState }) : routes,
			history  : get_history(),
			location : action.location
		})
		.then(({ redirect, router_state }) =>
		{
			// In case of a `react-router` `<Redirect/>`
			if (redirect)
			{
				// Shouldn't happen on the server-side in the current setup,
				// but just in case.
				if (server)
				{
					server_redirect(redirect)
				}

				// Perform client side redirect
				// (with target page preloading)
				return dispatch(redirect_action(redirect))
			}

			// Measures time taken (on the client side)
			let started_at

			if (!server)
			{
				// Measures time taken (on the client side)
				started_at = Date.now()

				// If on the client side, then store the current pending navigation,
				// so that it can be cancelled when a new navigation process takes place
				// before the current navigation process finishes.

				// If there's preceeding navigation pending,
				// then cancel that previous navigation.
				if (previous_preloading && previous_preloading.pending)
				{
					previous_preloading.cancel()
					// Page loading indicator could listen for this event
					dispatch({ type: Preload_finished })
				}
			}

			// Concatenated `react-router` route string.
			// E.g. "/user/:user_id/post/:post_id"
			const route = get_route_path(router_state)

			// `react-router` matched route "state"
			const { routes, components, location, params } = router_state

			// Preload all the required data for this route (page)
			const preload = preloader
			(
				action.initial,
				server,
				routes,
				components,
				getState,
				preloader_dispatch(dispatch, preloading),
				location,
				params,
				preload_helpers
			)

			// If nothing to preload, just move to the next middleware
			if (!preload)
			{
				// Trigger `react-router` navigation on client side
				// (and do nothing on server side)
				proceed_with_navigation(dispatch, action, server)
				// Explicitly return `undefined`
				// (not `false` by accident)
				return
			}

			// Page loading indicator could listen for this event
			dispatch({ type: Preload_started })
			
			// Preload the new page.
			// (the Promise returned is only used in server-side rendering,
			//  client-side rendering never uses this Promise)
			const promise = preload()

			preloading.pending = true

			// Preloading process cancellation
			preloading.cancel = () =>
			{
				preloading.cancelled = true

				// If `bluebird` is used,
				// and promise cancellation has been set up,
				// then cancel the `Promise`.
				// http://bluebirdjs.com/docs/api/cancellation.html
				if (promise.cancel)
				{
					promise.cancel()
				}
			}

			return promise
				// Navigate to the new page
				.then(() =>
				{
					// If this navigation process was cancelled
					// before @preload() finished its work,
					// then don't take any further steps on this cancelled navigation.
					if (preloading.cancelled)
					{
						// Update preloading status.
						preload_cancelled()
						// Return `false` out of the `Promise`
						// indicating that the navigation was cancelled.
						return false
					}

					// Page loading indicator could listen for this event
					dispatch({ type: Preload_finished })

					// Update preload status object
					preload_finished(Date.now() - started_at, route)

					// Trigger `react-router` navigation on client side
					// (and do nothing on server side)
					proceed_with_navigation(dispatch, action, server)
				},
				(error) =>
				{
					// If this navigation process was cancelled
					// before @preload() finished its work,
					// then don't take any further steps on this cancelled navigation.
					if (!preloading.cancelled)
					{
						if (!server)
						{
							preloading.error = error
						}

						// Page loading indicator could listen for this event
						dispatch({ type: Preload_failed, error })
					}

					throw error
				})
		})
		.catch((error) =>
		{
			// Update preload status object
			preload_failed(error)

			// If the error was a redirection exception (not a error),
			// then just exit and do nothing.
			// (happens only on server side)
			if (server && error._redirect)
			{
				// No need to emit `Preload_finished`
				// since the current page is simply discarded.
				throw error
			}

			// If no `on_preload_error` handler was set,
			// then use default behaviour.
			if (!error_handler)
			{
				// This error will be handled in `web server` `catch` clause
				// if this code is being run on the server side.
				if (server)
				{
					throw error
				}

				// On the client-side outputs errors to console by default
				console.error(error.stack || error)
				// Return `false` indicating that page preload failed
				return false
			}

			// Handle the error (for example, redirect to an error page)
			error_handler(error,
			{
				path : action.location.pathname,
				url  : location_url(action.location),
				// Using `goto_action` instead of `redirect_action` here
				// for better user experience (not loosing the initial URL)
				redirect : to => dispatch(goto_action(to)),
				dispatch,
				getState,
				server
			})

			// On the server side the page rendering process
			// still needs to be aborted, therefore the need to rethrow the error.
			// which means `preload.error` either `redirect`s or re`throw`s,
			// which are both `throw`s, so with a proper
			// `preload.error` handler this code wouldn't be reached.
			// (on the server side)
			if (server)
			{
				throw new Error(`"settings.catch" handler parameter must either redirect or rethrow the error (on server side)`)
			}

			// Return `false` indicating that page preload failed
			return false
		})
	}
}

// Trigger `react-router` navigation on client side
// (and do nothing on server side)
function proceed_with_navigation(dispatch, action, server)
{
	if (server)
	{
		return
	}

	if (action.navigate === false)
	{
		return
	}

	if (action.redirect)
	{
		dispatch(history_redirect_action(action.location))
	}
	else
	{
		dispatch(history_goto_action(action.location))
	}
}

// Returns function returning a Promise 
// which resolves when all the required preload()s are resolved.
//
// If no preloading is needed, then returns nothing.
//
const preloader = (initial_client_side_preload, server, routes, components, getState, dispatch, location, parameters, preload_helpers) =>
{
	let preload_arguments = { dispatch, getState, location, parameters }

	if (preload_helpers)
	{
		preload_arguments = { ...preload_arguments, ...preload_helpers }
	}

	// A minor optimization for skipping `@preload()`s
	// for those parent `<Route/>`s which haven't changed
	// as a result of a client-side navigation.
	//
	// On the client side:
	//
	// Take the previous route components
	// (along with their parameters) 
	// and the next route components
	// (along with their parameters),
	// and compare them side-by-side
	// filtering out the same top level components
	// (both having the same component classes
	//  and having the same parameters).
	//
	// Therefore @preload() methods could be skipped
	// for those top level components which remain
	// the same (and in the same state).
	// This would be an optimization.
	//
	// (e.g. the main <Route/> could be @preload()ed only once - on the server side)
	//
	// At the same time, at least one component should be preloaded:
	// even if navigating to the same page it still kinda makes sense to reload it.
	// (assuming it's not an "anchor" hyperlink navigation)
	//
	// Parameters for each `<Route/>` component can be found using this helper method:
	// https://github.com/ReactTraining/react-router/blob/master/modules/getRouteParams.js
	//
	// Also, GET query parameters would also need to be compared, I guess.
	// But, I guess, it would make sense to assume that GET parameters
	// only affect the last <Route/> component in the chain.
	// And, in general, GET query parameters should be avoided,
	// but that's not the case for example with search forms.
	// So here we assume that GET query parameters only
	// influence the last <Route/> component in the chain
	// which is gonna be reloaded anyway.
	//
	if (!server)
	{
		if (window._previous_routes)
		{
			const previous_routes     = window._previous_routes
			const previous_parameters = window._previous_route_parameters
		
			let i = 0
			while (i < routes.length - 1 && 
				previous_routes[i].component === routes[i].component &&
				deep_equal(getRouteParams(previous_routes[i], previous_parameters), getRouteParams(routes[i], parameters)))
			{
				i++
			}
		
			components = components.slice(i)
		}
		
		window._previous_routes           = routes
		window._previous_route_parameters = parameters
	}

	// finds all `preload` (or `preload_deferred`) methods 
	// (they will be executed in parallel)
	function get_preloaders()
	{
		// find all `preload` methods on the React-Router component chain
		return components
			.filter(component => component && component[Preload_method_name])
			.map(component =>
			({
				preload: () =>
				{
					try
					{
						// `preload()` returns a Promise
						let promise = component[Preload_method_name](preload_arguments)

						// Convert `array`s into `Promise.all(array)`
						if (Array.isArray(promise))
						{
							promise = Promise.all(promise)
						}

						// Sanity check
						if (!promise || typeof promise.then !== 'function')
						{
							return Promise.reject(`Preload function must return a Promise. Got:`, promise)
						}

						return promise
					}
					catch (error)
					{
						return Promise.reject(error)
					}
				},
				options: component[Preload_options_name] || {}
			}))
	}

	// Get all `preload` methods on the React-Router component chain
	const preloads = get_preloaders()

	// Construct `preload` chain

	let chain = []
	let parallel = []

	for (let preloader of get_preloaders())
	{
		// Don't execute client-side-only `@preload()`s on server side
		if (preloader.options.client && server)
		{
			continue
		}

		// If it's initial client side preload (after the page has been loaded),
		// then only execute those `@preload()`s marked as "client-side-only".
		if (initial_client_side_preload && !preloader.options.client)
		{
			continue
		}

		if (preloader.options.blocking === false)
		{
			parallel.push(preloader.preload)
			continue
		}

		// Copy-pasta
		if (parallel.length > 0)
		{
			parallel.push(preloader.preload)
			chain.push(parallel)
			parallel = []
		}
		else
		{
			chain.push(preloader.preload)
		}
	}

	// Finalize trailing parallel `preload`s
	if (parallel.length > 0)
	{
		chain.push(parallel.length > 1 ? parallel : parallel[0])
	}

	// Convert `preload` chain into `Promise` chain

	if (chain.length === 0)
	{
		return
	}

	return function()
	{
		return chain.reduce((promise, link) =>
		{
			if (Array.isArray(link))
			{
				return promise.then(() => Promise.all(link.map(_ => _())))
			}

			return promise.then(link)
		},
		Promise.resolve())
	}
}

// A special flavour of `dispatch` which `throw`s for redirects on the server side.
function preloading_middleware_dispatch(dispatch, server)
{
	return (event) =>
	{
		switch (event.type)
		{
			// In case of navigation from @preload()
			case Preload:
				// `throw`s a special `Error` on server side
				if (server)
				{
					server_redirect(event.location)
				}
		}

		// Proceed with the original
		return dispatch(event)
	}
}

// A special flavour of `dispatch` for `@preload()` arguments.
// It detects redirection or navigation and cancels the current preload.
function preloader_dispatch(dispatch, preloading)
{
	return (event) =>
	{
		switch (event.type)
		{
			// In case of navigation from @preload()
			case Preload:
				// Discard the currently ongoing preloading
				preloading.cancel()
				// Page loading indicator could listen for this event
				dispatch({ type: Preload_finished })
		}

		// Mark `http` calls so that they don't get "error handled" twice
		// (doesn't affect anything, just a minor optimization)
		if (typeof event.promise === 'function')
		{
			event.preloading = true
		}

		// Proceed with the original
		return dispatch(event)
	}
}