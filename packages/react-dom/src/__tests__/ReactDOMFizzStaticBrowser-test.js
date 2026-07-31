/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment ./scripts/jest/ReactDOMServerIntegrationEnvironment
 */

'use strict';

import {patchMessageChannel} from '../../../../scripts/jest/patchMessageChannel';

import {
  getVisibleChildren,
  insertNodesAndExecuteScripts,
} from '../test-utils/FizzTestUtils';

// Polyfills for test environment
global.ReadableStream =
  require('web-streams-polyfill/ponyfill/es6').ReadableStream;
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

let JSDOM;
let React;
let ReactDOMFizzServer;
let ReactDOMFizzStatic;
let Suspense;
let SuspenseList;
let container;
let serverAct;

describe('ReactDOMFizzStaticBrowser', () => {
  beforeEach(() => {
    jest.resetModules();
    JSDOM = require('jsdom').JSDOM;

    // We need the mocked version of setTimeout inside the document.
    window.setTimeout = setTimeout;
    window.requestAnimationFrame = setTimeout;

    patchMessageChannel();
    serverAct = require('internal-test-utils').serverAct;

    React = require('react');
    ReactDOMFizzServer = require('react-dom/server.browser');
    ReactDOMFizzStatic = require('react-dom/static.browser');
    Suspense = React.Suspense;
    SuspenseList = React.unstable_SuspenseList;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (typeof global.window.__restoreGlobalScope === 'function') {
      global.window.__restoreGlobalScope();
    }
    document.body.removeChild(container);
  });

  const theError = new Error('This is an error');
  function Throw() {
    throw theError;
  }
  const theInfinitePromise = new Promise(() => {});
  function InfiniteSuspend() {
    throw theInfinitePromise;
  }

  async function readContent(stream) {
    const reader = stream.getReader();
    let content = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        return content;
      }
      content += Buffer.from(value).toString('utf8');
    }
  }

  async function readIntoContainer(stream) {
    const reader = stream.getReader();
    let result = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      result += Buffer.from(value).toString('utf8');
    }
    const temp = document.createElement('div');
    temp.innerHTML = result;
    await insertNodesAndExecuteScripts(temp, container, null);
    jest.runAllTimers();
  }

  // Same as readIntoContainer, but leaves the reveal batch pending so that a
  // subsequent stream's instructions run inside the batch window.
  async function readIntoContainerWithoutRevealing(stream) {
    const reader = stream.getReader();
    let result = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      result += Buffer.from(value).toString('utf8');
    }
    const temp = document.createElement('div');
    temp.innerHTML = result;
    await insertNodesAndExecuteScripts(temp, container, null);
  }

  async function readIntoNewDocument(stream) {
    const content = await readContent(stream);
    const jsdom = new JSDOM(
      // The Fizz runtime assumes requestAnimationFrame exists so we need to polyfill it.
      '<script>window.requestAnimationFrame = setTimeout;</script>' + content,
      {
        runScripts: 'dangerously',
      },
    );
    const originalWindow = global.window;
    const originalDocument = global.document;
    const originalNavigator = global.navigator;
    const originalNode = global.Node;
    const originalAddEventListener = global.addEventListener;
    const originalMutationObserver = global.MutationObserver;
    global.window = jsdom.window;
    global.document = global.window.document;
    global.navigator = global.window.navigator;
    global.Node = global.window.Node;
    global.addEventListener = global.window.addEventListener;
    global.MutationObserver = global.window.MutationObserver;
    global.window.__restoreGlobalScope = () => {
      global.window = originalWindow;
      global.document = originalDocument;
      global.navigator = originalNavigator;
      global.Node = originalNode;
      global.addEventListener = originalAddEventListener;
      global.MutationObserver = originalMutationObserver;
    };
  }

  async function readIntoCurrentDocument(stream) {
    const content = await readContent(stream);
    const temp = document.createElement('div');
    temp.innerHTML = content;
    await insertNodesAndExecuteScripts(temp, document.body, null);
    jest.runAllTimers();
  }

  it('should call prerender', async () => {
    const result = await serverAct(() =>
      ReactDOMFizzStatic.prerender(<div>hello world</div>),
    );
    const prelude = await readContent(result.prelude);
    expect(prelude).toMatchInlineSnapshot(`"<div>hello world</div>"`);
  });

  it('should emit DOCTYPE at the root of the document', async () => {
    const result = await serverAct(() =>
      ReactDOMFizzStatic.prerender(
        <html>
          <body>hello world</body>
        </html>,
      ),
    );
    const prelude = await readContent(result.prelude);
    if (gate(flags => flags.enableFizzBlockingRender)) {
      expect(prelude).toMatchInlineSnapshot(
        `"<!DOCTYPE html><html><head><link rel="expect" href="#_R_" blocking="render"/></head><body>hello world<template id="_R_"></template></body></html>"`,
      );
    } else {
      expect(prelude).toMatchInlineSnapshot(
        `"<!DOCTYPE html><html><head></head><body>hello world</body></html>"`,
      );
    }
  });

  it('should emit bootstrap script src at the end', async () => {
    const result = await serverAct(() =>
      ReactDOMFizzStatic.prerender(<div>hello world</div>, {
        bootstrapScriptContent: 'INIT();',
        bootstrapScripts: ['init.js'],
        bootstrapModules: ['init.mjs'],
      }),
    );
    const prelude = await readContent(result.prelude);
    expect(prelude).toMatchInlineSnapshot(
      `"<link rel="preload" as="script" fetchPriority="low" href="init.js"/><link rel="modulepreload" fetchPriority="low" href="init.mjs"/><div>hello world</div><script id="_R_">INIT();</script><script src="init.js" async=""></script><script type="module" src="init.mjs" async=""></script>"`,
    );
  });

  it('emits all HTML as one unit', async () => {
    let hasLoaded = false;
    let resolve;
    const promise = new Promise(r => (resolve = r));
    function Wait() {
      if (!hasLoaded) {
        throw promise;
      }
      return 'Done';
    }
    const resultPromise = serverAct(() =>
      ReactDOMFizzStatic.prerender(
        <div>
          <Suspense fallback="Loading">
            <Wait />
          </Suspense>
        </div>,
      ),
    );

    await jest.runAllTimers();

    // Resolve the loading.
    hasLoaded = true;
    await resolve();

    const result = await resultPromise;
    const prelude = await readContent(result.prelude);
    expect(prelude).toMatchInlineSnapshot(`"<div><!--$-->Done<!--/$--></div>"`);
  });

  it('should reject the promise when an error is thrown at the root', async () => {
    const reportedErrors = [];
    let caughtError = null;
    try {
      await serverAct(() =>
        ReactDOMFizzStatic.prerender(
          <div>
            <Throw />
          </div>,
          {
            onError(x) {
              reportedErrors.push(x);
            },
          },
        ),
      );
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBe(theError);
    expect(reportedErrors).toEqual([theError]);
  });

  it('should reject the promise when an error is thrown inside a fallback', async () => {
    const reportedErrors = [];
    let caughtError = null;
    try {
      await serverAct(() =>
        ReactDOMFizzStatic.prerender(
          <div>
            <Suspense fallback={<Throw />}>
              <InfiniteSuspend />
            </Suspense>
          </div>,
          {
            onError(x) {
              reportedErrors.push(x);
            },
          },
        ),
      );
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBe(theError);
    expect(reportedErrors).toEqual([theError]);
  });

  it('should not error the stream when an error is thrown inside suspense boundary', async () => {
    const reportedErrors = [];
    const result = await serverAct(() =>
      ReactDOMFizzStatic.prerender(
        <div>
          <Suspense fallback={<div>Loading</div>}>
            <Throw />
          </Suspense>
        </div>,
        {
          onError(x) {
            reportedErrors.push(x);
          },
        },
      ),
    );

    const prelude = await readContent(result.prelude);
    expect(prelude).toContain('Loading');
    expect(reportedErrors).toEqual([theError]);
  });

  it('should be able to complete by aborting even if the promise never resolves', async () => {
    const errors = [];
    const controller = new AbortController();
    let resultPromise;
    await serverAct(() => {
      resultPromise = ReactDOMFizzStatic.prerender(
        <div>
          <Suspense fallback={<div>Loading</div>}>
            <InfiniteSuspend />
          </Suspense>
        </div>,
        {
          signal: controller.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      );
    });

    controller.abort();

    const result = await resultPromise;

    const prelude = await readContent(result.prelude);
    expect(prelude).toContain('Loading');

    expect(errors).toEqual(['This operation was aborted']);
  });

  // @gate !enableHalt
  it('should reject if aborting before the shell is complete and enableHalt is disabled', async () => {
    const errors = [];
    const controller = new AbortController();
    const promise = serverAct(() =>
      ReactDOMFizzStatic.prerender(
        <div>
          <InfiniteSuspend />
        </div>,
        {
          signal: controller.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      ),
    );

    await jest.runAllTimers();

    const theReason = new Error('aborted for reasons');
    controller.abort(theReason);

    let caughtError = null;
    try {
      await promise;
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBe(theReason);
    expect(errors).toEqual(['aborted for reasons']);
  });

  // @gate enableHalt
  it('should resolve an empty prelude if aborting before the shell is complete', async () => {
    const errors = [];
    const controller = new AbortController();
    const promise = serverAct(() =>
      ReactDOMFizzStatic.prerender(
        <div>
          <InfiniteSuspend />
        </div>,
        {
          signal: controller.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      ),
    );

    await jest.runAllTimers();

    const theReason = new Error('aborted for reasons');
    controller.abort(theReason);

    let rejected = false;
    let prelude;
    try {
      ({prelude} = await promise);
    } catch (error) {
      rejected = true;
    }
    expect(rejected).toBe(false);
    expect(errors).toEqual(['aborted for reasons']);
    const content = await readContent(prelude);
    expect(content).toBe('');
  });

  it('should be able to abort before something suspends', async () => {
    const errors = [];
    const controller = new AbortController();
    function App() {
      controller.abort();
      return (
        <Suspense fallback={<div>Loading</div>}>
          <InfiniteSuspend />
        </Suspense>
      );
    }
    const streamPromise = serverAct(() =>
      ReactDOMFizzStatic.prerender(
        <div>
          <App />
        </div>,
        {
          signal: controller.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      ),
    );

    if (gate(flags => flags.enableHalt)) {
      const {prelude} = await streamPromise;
      const content = await readContent(prelude);
      expect(errors).toEqual(['This operation was aborted']);
      expect(content).toBe('');
    } else {
      let caughtError = null;
      try {
        await streamPromise;
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError.message).toBe('This operation was aborted');
      expect(errors).toEqual(['This operation was aborted']);
    }
  });

  // @gate !enableHalt
  it('should reject if passing an already aborted signal and enableHalt is disabled', async () => {
    const errors = [];
    const controller = new AbortController();
    const theReason = new Error('aborted for reasons');
    controller.abort(theReason);

    const promise = serverAct(() =>
      ReactDOMFizzStatic.prerender(
        <div>
          <Suspense fallback={<div>Loading</div>}>
            <InfiniteSuspend />
          </Suspense>
        </div>,
        {
          signal: controller.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      ),
    );

    // Technically we could still continue rendering the shell but currently the
    // semantics mean that we also abort any pending CPU work.
    let caughtError = null;
    try {
      await promise;
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBe(theReason);
    expect(errors).toEqual(['aborted for reasons']);
  });

  // @gate enableHalt
  it('should resolve an empty prelude if passing an already aborted signal', async () => {
    const errors = [];
    const controller = new AbortController();
    const theReason = new Error('aborted for reasons');
    controller.abort(theReason);

    const promise = serverAct(() =>
      ReactDOMFizzStatic.prerender(
        <div>
          <Suspense fallback={<div>Loading</div>}>
            <InfiniteSuspend />
          </Suspense>
        </div>,
        {
          signal: controller.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      ),
    );

    // Technically we could still continue rendering the shell but currently the
    // semantics mean that we also abort any pending CPU work.
    let didThrow = false;
    let prelude;
    try {
      ({prelude} = await promise);
    } catch (error) {
      didThrow = true;
    }
    expect(didThrow).toBe(false);
    expect(errors).toEqual(['aborted for reasons']);
    const content = await readContent(prelude);
    expect(content).toBe('');
  });

  it('supports custom abort reasons with a string', async () => {
    const promise = new Promise(r => {});
    function Wait() {
      throw promise;
    }
    function App() {
      return (
        <div>
          <p>
            <Suspense fallback={'p'}>
              <Wait />
            </Suspense>
          </p>
          <span>
            <Suspense fallback={'span'}>
              <Wait />
            </Suspense>
          </span>
        </div>
      );
    }

    const errors = [];
    const controller = new AbortController();
    let resultPromise;
    await serverAct(() => {
      resultPromise = ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError(x) {
          errors.push(x);
          return 'a digest';
        },
      });
    });

    controller.abort('foobar');

    await resultPromise;

    expect(errors).toEqual(['foobar', 'foobar']);
  });

  it('supports custom abort reasons with an Error', async () => {
    const promise = new Promise(r => {});
    function Wait() {
      throw promise;
    }
    function App() {
      return (
        <div>
          <p>
            <Suspense fallback={'p'}>
              <Wait />
            </Suspense>
          </p>
          <span>
            <Suspense fallback={'span'}>
              <Wait />
            </Suspense>
          </span>
        </div>
      );
    }

    const errors = [];
    const controller = new AbortController();
    let resultPromise;
    await serverAct(() => {
      resultPromise = ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError(x) {
          errors.push(x.message);
          return 'a digest';
        },
      });
    });

    controller.abort(new Error('uh oh'));

    await resultPromise;

    expect(errors).toEqual(['uh oh', 'uh oh']);
  });

  it('logs an error if onHeaders throws but continues the prerender', async () => {
    const errors = [];
    function onError(error) {
      errors.push(error.message);
    }

    function onHeaders(x) {
      throw new Error('bad onHeaders');
    }

    const prerendered = await serverAct(() =>
      ReactDOMFizzStatic.prerender(<div>hello</div>, {
        onHeaders,
        onError,
      }),
    );
    expect(prerendered.postponed).toBe(
      gate(flags => flags.enableHalt) ? null : undefined,
    );
    expect(errors).toEqual(['bad onHeaders']);

    await readIntoContainer(prerendered.prelude);
    expect(getVisibleChildren(container)).toEqual(<div>hello</div>);
  });

  // @gate enableHalt
  it('can resume render of a prerender', async () => {
    const errors = [];

    let resolveA;
    const promiseA = new Promise(r => (resolveA = r));
    let resolveB;
    const promiseB = new Promise(r => (resolveB = r));

    async function ComponentA() {
      await promiseA;
      return (
        <Suspense fallback="Loading B">
          <ComponentB />
        </Suspense>
      );
    }

    async function ComponentB() {
      await promiseB;
      return 'Hello';
    }

    function App() {
      return (
        <div>
          <Suspense fallback="Loading A">
            <ComponentA />
          </Suspense>
        </div>
      );
    }

    const controller = new AbortController();
    let pendingResult;
    await serverAct(async () => {
      pendingResult = ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError(x) {
          errors.push(x.message);
        },
      });
    });

    controller.abort();
    const prerendered = await pendingResult;
    const postponedState = JSON.stringify(prerendered.postponed);

    await readIntoContainer(prerendered.prelude);
    expect(getVisibleChildren(container)).toEqual(<div>Loading A</div>);

    await resolveA();

    expect(prerendered.postponed).not.toBe(null);

    const controller2 = new AbortController();
    await serverAct(async () => {
      pendingResult = ReactDOMFizzStatic.resumeAndPrerender(
        <App />,
        JSON.parse(postponedState),
        {
          signal: controller2.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      );
    });

    controller2.abort();

    const prerendered2 = await pendingResult;
    const postponedState2 = JSON.stringify(prerendered2.postponed);

    await readIntoContainer(prerendered2.prelude);
    expect(getVisibleChildren(container)).toEqual(<div>Loading B</div>);

    await resolveB();

    const dynamic = await serverAct(() =>
      ReactDOMFizzServer.resume(<App />, JSON.parse(postponedState2)),
    );

    await readIntoContainer(dynamic);
    expect(getVisibleChildren(container)).toEqual(<div>Hello</div>);
  });

  // @gate enableHalt
  it('can prerender a preamble', async () => {
    const errors = [];

    let resolveA;
    const promiseA = new Promise(r => (resolveA = r));
    let resolveB;
    const promiseB = new Promise(r => (resolveB = r));

    async function ComponentA() {
      await promiseA;
      return (
        <Suspense fallback="Loading B">
          <ComponentB />
        </Suspense>
      );
    }

    async function ComponentB() {
      await promiseB;
      return 'Hello';
    }

    function App() {
      return (
        <Suspense>
          <html data-x="">
            <body data-x="">
              <Suspense fallback="Loading A">
                <ComponentA />
              </Suspense>
            </body>
          </html>
        </Suspense>
      );
    }

    const controller = new AbortController();
    let pendingResult;
    await serverAct(async () => {
      pendingResult = ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError(x) {
          errors.push(x.message);
        },
      });
    });

    controller.abort();

    const prerendered = await pendingResult;
    const postponedState = JSON.stringify(prerendered.postponed);

    await readIntoNewDocument(prerendered.prelude);
    expect(getVisibleChildren(document)).toEqual(
      <html data-x="">
        <head />
        <body data-x="">Loading A</body>
      </html>,
    );

    await resolveA();

    expect(prerendered.postponed).not.toBe(null);

    const controller2 = new AbortController();
    await serverAct(async () => {
      pendingResult = ReactDOMFizzStatic.resumeAndPrerender(
        <App />,
        JSON.parse(postponedState),
        {
          signal: controller2.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      );
    });

    controller2.abort();

    const prerendered2 = await pendingResult;
    const postponedState2 = JSON.stringify(prerendered2.postponed);

    await readIntoCurrentDocument(prerendered2.prelude);
    expect(getVisibleChildren(document)).toEqual(
      <html data-x="">
        <head />
        <body data-x="">Loading B</body>
      </html>,
    );

    await resolveB();

    const dynamic = await serverAct(() =>
      ReactDOMFizzServer.resume(<App />, JSON.parse(postponedState2)),
    );

    await readIntoCurrentDocument(dynamic);
    expect(getVisibleChildren(document)).toEqual(
      <html data-x="">
        <head />
        <body data-x="">Hello</body>
      </html>,
    );
  });

  it('can suspend inside <head> tag', async () => {
    const promise = new Promise(() => {});

    function App() {
      return (
        <html>
          <head>
            <Suspense fallback={<meta itemProp="" content="fallback" />}>
              <Metadata />
            </Suspense>
          </head>
          <body>
            <div>hello</div>
          </body>
        </html>
      );
    }

    function Metadata() {
      React.use(promise);
      return <meta itemProp="" content="primary" />;
    }

    const controller = new AbortController();
    let pendingResult;
    const errors = [];
    await serverAct(() => {
      pendingResult = ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError: e => {
          errors.push(e.message);
        },
      });
    });

    controller.abort(new Error('boom'));

    const prerendered = await pendingResult;

    await readIntoNewDocument(prerendered.prelude);
    expect(getVisibleChildren(document)).toEqual(
      <html>
        <head>
          <meta itemprop="" content="fallback" />
        </head>
        <body>
          <div>hello</div>
        </body>
      </html>,
    );

    expect(errors).toEqual(['boom']);
  });

  // @gate enableHalt
  it('will render fallback Document when erroring a boundary above the body', async () => {
    let isPrerendering = true;
    const promise = new Promise(() => {});

    function Boom() {
      if (isPrerendering) {
        React.use(promise);
      }
      throw new Error('Boom!');
    }

    function App() {
      return (
        <Suspense
          fallback={
            <html data-error-html="">
              <body data-error-body="">
                <span>hello error</span>
              </body>
            </html>
          }>
          <html data-content-html="">
            <body data-content-body="">
              <Boom />
              <span>hello world</span>
            </body>
          </html>
        </Suspense>
      );
    }

    const controller = new AbortController();
    let pendingResult;
    const errors = [];
    await serverAct(() => {
      pendingResult = ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError: e => {
          errors.push(e.message);
        },
      });
    });

    controller.abort();

    const prerendered = await pendingResult;

    expect(errors).toEqual(['This operation was aborted']);
    const content = await readContent(prerendered.prelude);
    expect(content).toBe('');

    isPrerendering = false;
    const postponedState = JSON.stringify(prerendered.postponed);

    const resumeErrors = [];
    const dynamic = await serverAct(() =>
      ReactDOMFizzServer.resume(<App />, JSON.parse(postponedState), {
        onError: e => {
          resumeErrors.push(e.message);
        },
      }),
    );

    expect(resumeErrors).toEqual(['Boom!']);
    await readIntoNewDocument(dynamic);

    expect(getVisibleChildren(document)).toEqual(
      <html data-error-html="">
        <head />
        <body data-error-body="">
          <span>hello error</span>
        </body>
      </html>,
    );
  });

  // @gate enableHalt
  it('can omit a preamble with an empty shell if no preamble is ready when prerendering finishes', async () => {
    const errors = [];

    let resolveA;
    const promiseA = new Promise(r => (resolveA = r));
    let resolveB;
    const promiseB = new Promise(r => (resolveB = r));

    async function ComponentA() {
      await promiseA;
      return (
        <Suspense fallback="Loading B">
          <ComponentB />
        </Suspense>
      );
    }

    async function ComponentB() {
      await promiseB;
      return 'Hello';
    }

    function App() {
      return (
        <Suspense>
          <html data-x="">
            <body data-x="">
              <ComponentA />
            </body>
          </html>
        </Suspense>
      );
    }

    const controller = new AbortController();
    let pendingResult;
    await serverAct(async () => {
      pendingResult = ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError(x) {
          errors.push(x.message);
        },
      });
    });

    controller.abort();

    const prerendered = await pendingResult;
    const postponedState = JSON.stringify(prerendered.postponed);

    const content = await readContent(prerendered.prelude);
    expect(content).toBe('');

    await resolveA();

    expect(prerendered.postponed).not.toBe(null);

    const controller2 = new AbortController();
    await serverAct(async () => {
      pendingResult = ReactDOMFizzStatic.resumeAndPrerender(
        <App />,
        JSON.parse(postponedState),
        {
          signal: controller2.signal,
          onError(x) {
            errors.push(x.message);
          },
        },
      );
    });

    controller2.abort();

    const prerendered2 = await pendingResult;
    const postponedState2 = JSON.stringify(prerendered2.postponed);

    await readIntoNewDocument(prerendered2.prelude);
    expect(getVisibleChildren(document)).toEqual(
      <html data-x="">
        <head />
        <body data-x="">Loading B</body>
      </html>,
    );

    await resolveB();

    const dynamic = await serverAct(() =>
      ReactDOMFizzServer.resume(<App />, JSON.parse(postponedState2)),
    );

    await readIntoCurrentDocument(dynamic);
    expect(getVisibleChildren(document)).toEqual(
      <html data-x="">
        <head />
        <body data-x="">Hello</body>
      </html>,
    );
  });

  // @gate enableHalt && enableSuspenseList
  it('can resume a partially prerendered SuspenseList', async () => {
    const errors = [];

    let resolveA;
    const promiseA = new Promise(r => (resolveA = r));
    let resolveB;
    const promiseB = new Promise(r => (resolveB = r));

    async function ComponentA() {
      await promiseA;
      return 'A';
    }

    async function ComponentB() {
      await promiseB;
      return 'B';
    }

    function App() {
      return (
        <div>
          <SuspenseList revealOrder="forwards" tail="visible">
            <Suspense fallback="Loading A">
              <ComponentA />
            </Suspense>
            <Suspense fallback="Loading B">
              <ComponentB />
            </Suspense>
            <Suspense fallback="Loading C">C</Suspense>
            <Suspense fallback="Loading D">D</Suspense>
          </SuspenseList>
        </div>
      );
    }

    const controller = new AbortController();
    const pendingResult = serverAct(() =>
      ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError(x) {
          errors.push(x.message);
        },
      }),
    );

    await serverAct(() => {
      controller.abort();
    });

    const prerendered = await pendingResult;

    const postponedState = JSON.stringify(prerendered.postponed);

    await readIntoContainer(prerendered.prelude);
    expect(getVisibleChildren(container)).toEqual(
      <div>
        {'Loading A'}
        {'Loading B'}
        {'Loading C'}
        {'Loading D'}
      </div>,
    );

    expect(prerendered.postponed).not.toBe(null);

    await resolveA();
    await resolveB();

    const dynamic = await serverAct(() =>
      ReactDOMFizzServer.resume(<App />, JSON.parse(postponedState)),
    );

    await readIntoContainer(dynamic);

    expect(getVisibleChildren(container)).toEqual(
      <div>
        {'A'}
        {'B'}
        {'C'}
        {'D'}
      </div>,
    );
  });

  // @gate enableHalt && enableOptimisticKey
  it('can resume an optimistic keyed slot', async () => {
    const errors = [];

    let resolve;
    const promise = new Promise(r => (resolve = r));

    async function Component() {
      await promise;
      return 'Hi';
    }

    if (React.optimisticKey === undefined) {
      throw new Error('optimisticKey missing');
    }

    function App() {
      return (
        <div>
          <Suspense fallback="Loading">
            <Component key={React.optimisticKey} />
          </Suspense>
        </div>
      );
    }

    const controller = new AbortController();
    const pendingResult = serverAct(() =>
      ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        onError(x) {
          errors.push(x.message);
        },
      }),
    );

    await serverAct(() => {
      controller.abort();
    });

    const prerendered = await pendingResult;

    const postponedState = JSON.stringify(prerendered.postponed);

    await readIntoContainer(prerendered.prelude);
    expect(getVisibleChildren(container)).toEqual(<div>Loading</div>);

    expect(prerendered.postponed).not.toBe(null);

    await resolve();

    const dynamic = await serverAct(() =>
      ReactDOMFizzServer.resume(<App />, JSON.parse(postponedState)),
    );

    await readIntoContainer(dynamic);

    expect(getVisibleChildren(container)).toEqual(<div>Hi</div>);
  });

  // The postponed state snapshots the segment id counter before the prelude is
  // flushed, and flushing the prelude keeps allocating from that same counter,
  // so a resumed stream can reuse an id whose shell boundary is still waiting
  // in the reveal batch. This test verifies that the resumed stream's
  // completion instruction cannot resolve that queued shell node; if it could,
  // it would consume the shell's nodes and never reveal its own boundary.
  //
  // The apps below keep their shell deliberately tiny: with
  // progressiveChunkSize 1 anything larger trips React's unrelated advisory
  // about a large render-blocking shell.
  // @gate enableHalt
  it("does not reveal a resumed boundary into the shell's queued segment", async () => {
    const errors = [];

    let resolveOutlined;
    const promiseOutlined = new Promise(r => (resolveOutlined = r));
    let resolveHalted;
    const promiseHalted = new Promise(r => (resolveHalted = r));
    let resolveNested;
    const promiseNested = new Promise(r => (resolveNested = r));

    // These boundaries have no preamble, so padding them past 500 bytes makes
    // them eligible for the byte-size outlining path, and outlining into a
    // hidden container is what puts a boundary into the reveal batch.
    const outlinedText = 'outlined-' + 'o'.repeat(600);
    const nestedText = 'nested-' + 'n'.repeat(600);

    async function Outlined() {
      await promiseOutlined;
      return <div>{outlinedText}</div>;
    }

    async function Nested() {
      await promiseNested;
      return <div>{nestedText}</div>;
    }

    async function Halted() {
      await promiseHalted;
      return (
        <div>
          {'halted-shell'}
          <Suspense fallback="pendN">
            <Nested />
          </Suspense>
        </div>
      );
    }

    function App() {
      return (
        <div>
          <Suspense fallback="pendA">
            <Outlined />
          </Suspense>
          <Suspense fallback="pendB">
            <Halted />
          </Suspense>
        </div>
      );
    }

    const controller = new AbortController();
    let pendingResult;
    await serverAct(async () => {
      pendingResult = ReactDOMFizzStatic.prerender(<App />, {
        signal: controller.signal,
        progressiveChunkSize: 1,
        onError(x) {
          errors.push(x.message);
        },
      });
    });

    // The first boundary resolves before the abort so that the prelude outlines
    // it, while the second one is still pending and gets halted.
    await serverAct(async () => {
      resolveOutlined();
    });

    controller.abort();

    const prerendered = await pendingResult;
    expect(prerendered.postponed).not.toBe(null);
    const postponedState = JSON.stringify(prerendered.postponed);

    await serverAct(async () => {
      resolveHalted();
    });

    const dynamic = await serverAct(() =>
      ReactDOMFizzServer.resume(<App />, JSON.parse(postponedState), {
        progressiveChunkSize: 1,
        onError(x) {
          errors.push(x.message);
        },
      }),
    );

    // The nested boundary resolves only once the resume has started, so the
    // resumed payload carries its own completion instruction. Every promise is
    // settled before the first insertion because serverAct flushes pending
    // timers, which would reveal the batch early.
    await serverAct(async () => {
      resolveNested();
    });

    await readIntoContainerWithoutRevealing(prerendered.prelude);

    // The prelude's outlined content is still parked in its hidden container,
    // i.e. the reveal batch is genuinely pending. Without that the resumed
    // stream's instructions would not run inside the window at all.
    expect(container.querySelectorAll('div[hidden]').length).toBe(1);

    await readIntoContainerWithoutRevealing(dynamic);

    jest.runAllTimers();

    expect(getVisibleChildren(container)).toEqual(
      <div>
        <div>{outlinedText}</div>
        <div>
          {'halted-shell'}
          <div>{nestedText}</div>
        </div>
      </div>,
    );
    expect(container.querySelectorAll('div[hidden]').length).toBe(0);

    // getVisibleChildren never returns comment nodes, so the boundary markers
    // have to be inspected directly: no boundary may still be pending or
    // queued once the reveal has run.
    const walker = container.ownerDocument.createTreeWalker(
      container,
      window.NodeFilter.SHOW_COMMENT,
    );
    const unrevealedBoundaries = [];
    while (walker.nextNode()) {
      const data = walker.currentNode.data;
      if (data === '$?' || data === '$~') {
        unrevealedBoundaries.push(data);
      }
    }
    expect(unrevealedBoundaries).toEqual([]);

    expect(errors).toEqual(['This operation was aborted']);
  });

  // React coordinates no numbering between independently created streams, so
  // they can reuse each other's identifiers. The first document below parks two
  // completed boundaries in the reveal batch, including the container emitted
  // as S:1; the second document then runs its own $RS("S:1","P:1"). While a
  // queued id stays discoverable that lookup lands on the first document's
  // container - getElementById answers with the first match in tree order - and
  // splices one application's content into the other's placeholder.
  it('composes two independently generated streams without cross-stream segment capture', async () => {
    const errors = [];

    let resolveFirst;
    const promiseFirst = new Promise(r => (resolveFirst = r));
    let resolveSecond;
    const promiseSecond = new Promise(r => (resolveSecond = r));
    let resolveNested;
    const promiseNested = new Promise(r => (resolveNested = r));

    // These boundaries have no preamble either, so padding them past 500
    // bytes makes each one eligible for the byte-size outlining path: each is
    // emitted into a hidden container and joins the reveal batch.
    const firstText = 'first-' + 'f'.repeat(600);
    const secondText = 'second-' + 's'.repeat(600);
    const nestedText = 'nested-content';

    async function First() {
      await promiseFirst;
      return <div>{firstText}</div>;
    }

    async function Second() {
      await promiseSecond;
      return <div>{secondText}</div>;
    }

    // Two boundaries, so this document alone occupies both S:0 and S:1.
    function FirstApp() {
      return (
        <div>
          <Suspense fallback="pendFirst">
            <First />
          </Suspense>
          <Suspense fallback="pendSecond">
            <Second />
          </Suspense>
        </div>
      );
    }

    async function Nested() {
      await promiseNested;
      return nestedText;
    }

    // A complete head and tail around a late suspension is what makes React
    // emit a placeholder for a partial segment, and with it the segment
    // completion instruction that consumes the colliding S:1.
    function SecondApp() {
      return (
        <div>
          <Suspense fallback="pendNested">
            <div>
              {'head'}
              <b>
                {'mid '}
                <Nested />
              </b>
              {'tail'}
            </div>
          </Suspense>
        </div>
      );
    }

    const firstStream = await serverAct(() =>
      ReactDOMFizzServer.renderToReadableStream(<FirstApp />, {
        progressiveChunkSize: 1,
        onError(x) {
          errors.push(x.message);
        },
      }),
    );

    // The first document finishes rendering before anything is inserted, so it
    // arrives complete the way a cached response would.
    await serverAct(async () => {
      resolveFirst();
      resolveSecond();
    });

    const secondStream = await serverAct(() =>
      ReactDOMFizzServer.renderToReadableStream(<SecondApp />, {
        progressiveChunkSize: 1,
        onError(x) {
          errors.push(x.message);
        },
      }),
    );

    // The second document has to be read while its nested suspension is still
    // outstanding, because a segment placeholder is only emitted if the
    // boundary's content flushes before that segment completes. Reading it up
    // front also keeps every serverAct call - each of which drains the fake
    // timers, and with them the reveal batch - ahead of the first insertion.
    const secondReading = readContent(secondStream);
    await serverAct(async () => {
      resolveNested();
    });
    const secondPayload = await secondReading;

    await readIntoContainerWithoutRevealing(firstStream);

    // Both of the first document's boundaries are queued for the reveal, so the
    // second document's instructions run while they are still parked.
    expect(container.querySelectorAll('div[hidden]').length).toBe(2);

    // The collision has to be armed for this test to prove anything: the first
    // document hands S:1 to the reveal batch and the second document completes
    // its own partial segment under that very identifier.
    const firstInstructions = Array.from(container.querySelectorAll('script'))
      .map(script => script.textContent)
      .join('');
    expect(firstInstructions).toContain('$RC("B:1","S:1")');
    expect(secondPayload).toContain('$RS("S:1","P:1")');

    // Insert the already read second document the way the non-draining helper
    // does. A cached response arrives in one burst, so both documents' scripts
    // run back to back without a timer in between.
    const secondDocument = document.createElement('div');
    secondDocument.innerHTML = secondPayload;
    await insertNodesAndExecuteScripts(secondDocument, container, null);

    jest.runAllTimers();

    // Each application has to reveal its own content. Capturing the first
    // document's queued segment instead leaves its second boundary revealed
    // empty and the second document's boundary pending forever.
    expect(getVisibleChildren(container)).toEqual([
      <div>
        <div>{firstText}</div>
        <div>{secondText}</div>
      </div>,
      <div>
        <div>
          {'head'}
          <b>
            {'mid '}
            {nestedText}
          </b>
          {'tail'}
        </div>
      </div>,
    ]);
    expect(container.querySelectorAll('div[hidden]').length).toBe(0);

    const walker = container.ownerDocument.createTreeWalker(
      container,
      window.NodeFilter.SHOW_COMMENT,
    );
    const unrevealedBoundaries = [];
    while (walker.nextNode()) {
      const data = walker.currentNode.data;
      if (data === '$?' || data === '$~') {
        unrevealedBoundaries.push(data);
      }
    }
    expect(unrevealedBoundaries).toEqual([]);

    expect(errors).toEqual([]);
  });

  it('completeSegment ignores a container that contains its placeholder', async () => {
    const errors = [];

    let resolveLate;
    const promiseLate = new Promise(r => (resolveLate = r));

    async function Late() {
      await promiseLate;
      return 'late-content';
    }

    // Suspending below an otherwise complete boundary is what makes React emit
    // a placeholder for a partial segment, and with it the segment completion
    // instruction whose shipped implementation this test exercises.
    function App() {
      return (
        <div>
          <Suspense fallback="pend">
            <div>
              {'head'}
              <b>
                {'mid '}
                <Late />
              </b>
              {'tail'}
            </div>
          </Suspense>
        </div>
      );
    }

    const stream = await serverAct(() =>
      ReactDOMFizzServer.renderToReadableStream(<App />, {
        onError(x) {
          errors.push(x.message);
        },
      }),
    );

    // Resolve while the read is in flight so that the shell is flushed with the
    // segment still outstanding. Resolving beforehand would render the whole
    // tree in one piece and no segment instruction would be emitted.
    const reading = readIntoContainerWithoutRevealing(stream);
    await serverAct(async () => {
      resolveLate();
    });
    await reading;

    jest.runAllTimers();

    expect(getVisibleChildren(container)).toEqual(
      <div>
        <div>
          {'head'}
          <b>
            {'mid '}
            {'late-content'}
          </b>
          {'tail'}
        </div>
      </div>,
    );

    // Read the instruction back off the window so that the assertion below
    // covers the implementation the server actually shipped.
    expect(typeof window.$RS).toBe('function');

    // A cross-stream id collision can hand the instruction a container that is
    // an ancestor of the placeholder it is supposed to splice into. Splicing
    // that in would throw and detach live content, so it has to be ignored and
    // the boundary left for the client to render.
    const segmentContainer = document.createElement('div');
    segmentContainer.hidden = true;
    segmentContainer.id = 'S:9';
    const nested = document.createElement('div');
    const placeholderNode = document.createElement('template');
    placeholderNode.id = 'P:9';
    nested.appendChild(placeholderNode);
    segmentContainer.appendChild(nested);
    container.appendChild(segmentContainer);

    const treeBefore = container.innerHTML;
    // The arguments are the container id first, then the placeholder id, which
    // is the order the server emits them in.
    expect(() => window.$RS('S:9', 'P:9')).not.toThrow();
    expect(container.innerHTML).toBe(treeBefore);
    expect(placeholderNode.parentNode).toBe(nested);
    expect(segmentContainer.parentNode).toBe(container);

    expect(errors).toEqual([]);
  });
});
