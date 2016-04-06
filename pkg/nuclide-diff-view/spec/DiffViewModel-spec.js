'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import invariant from 'assert';

import DiffViewModel from '../lib/DiffViewModel';
import Rx from 'rx';

describe('DiffViewModel', () => {
  let model = null;
  let messages = null;

  beforeEach(() => {
    model = new DiffViewModel([]);
    messages = model.getMessages();
    spyOn(messages, 'onNext').andCallThrough();
  });

  function stdoutLine(message: string): {stdout?: string; stderr?: string} {
    return {stdout: JSON.stringify({type: 'phutil:out', message})};
  }

  function testInput(
    input: Array<{stdout?: string; stderr?: string}>,
    expectedOutput: Array<{level: string; text: string}>,
  ): void {
    waitsForPromise(async () => {
      const stream = Rx.Observable.from(input);
      invariant(messages != null);
      const resultStream = messages.take(expectedOutput.length).toArray().toPromise();
      invariant(model != null);
      await model._processArcanistOutput(stream, 'success');
      const result = await resultStream;
      expect((messages: any).onNext.callCount).toEqual(expectedOutput.length);
      while (result.length > 0) {
        expect(result.pop()).toEqual(expectedOutput.pop());
      }
    });
  }

  it('can handle valid JSON', () => {
    const input = [
      stdoutLine('hello\nanother line\n'),
    ];
    const output = [
      {level: 'log', text: 'hello\n'},
      {level: 'log', text: 'another line\n'},
    ];
    testInput(input, output);
  });

  it('can handle non-JSON input', () => {
    const input = [
      stdoutLine('hello\n'),
      {stdout: 'foo\nbar\n'},
      stdoutLine('baz\n'),
    ];
    const output = [
      {level: 'log', text: 'hello\n'},
      {level: 'log', text: 'foo\n'},
      {level: 'log', text: 'bar\n'},
      {level: 'log', text: 'baz\n'},
    ];
    testInput(input, output);
  });

  it('works with multiple lines stuck together', () => {
    const fooOut = stdoutLine('foo').stdout;
    const barOut = stdoutLine('bar\n').stdout;
    invariant(fooOut != null);
    invariant(barOut != null);
    const input = [
      {stdout: fooOut + '\n' + barOut},
      stdoutLine('baz\n'),
    ];
    const output = [
      {level: 'log', text: 'foobar\n'},
      {level: 'log', text: 'baz\n'},
    ];
    testInput(input, output);
  });

  it('works with stderr', () => {
    const input = [
      {stderr: 'hello\nworld\n'},
      {stderr: 'more text here\n'},
    ];
    const output = [
      {level: 'error', text: 'hello\n'},
      {level: 'error', text: 'world\n'},
      {level: 'error', text: 'more text here\n'},
    ];
    testInput(input, output);
  });
});
