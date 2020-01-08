//
// Copyright 2019 DxOS.
//

import { promises as fs } from 'fs';
import path from 'path';

import ram from 'random-access-memory';
import crypto from 'hypercore-crypto';
import tempy from 'tempy';

import FeedDescriptor from './feed-descriptor';

describe('FeedDescriptor', () => {
  let fd = null;

  test('Create', () => {
    const fd = new FeedDescriptor('/foo');

    expect(fd).toBeInstanceOf(FeedDescriptor);
    expect(fd.path).toBe('/foo');
    expect(fd.key).toBeDefined();
    expect(fd.secretKey).toBeDefined();
  });

  test('Validate asserts', () => {
    expect(() => new FeedDescriptor()).toThrow(/path is required/);
    expect(() => new FeedDescriptor('/foo', { key: 'foo' })).toThrow(/key must be a buffer/);
    expect(() => new FeedDescriptor('/foo', { key: crypto.keyPair().publicKey, secretKey: 'foo' })).toThrow(/secretKey must be a buffer/);
    expect(() => new FeedDescriptor('/foo', { secretKey: crypto.keyPair().secretKey })).toThrow(/missing publicKey/);
    expect(() => new FeedDescriptor('/foo', { valueEncoding: {} })).toThrow(/valueEncoding must be a string/);
  });

  test('Create custom options', () => {
    const { publicKey, secretKey } = crypto.keyPair();

    const metadata = {
      subject: 'books'
    };

    fd = new FeedDescriptor('/books', {
      storage: ram,
      key: publicKey,
      secretKey,
      valueEncoding: 'json',
      metadata
    });

    expect(fd).toBeInstanceOf(FeedDescriptor);
    expect(fd.path).toBe('/books');
    expect(fd.key).toBeInstanceOf(Buffer);
    expect(fd.secretKey).toBeInstanceOf(Buffer);
    expect(fd.metadata).toEqual(metadata);
    expect(fd.valueEncoding).toBe('json');
  });

  test('Open', async () => {
    expect(fd.feed).toBeNull();
    expect(fd.opened).toBe(false);

    // Opening multiple times should actually open once.
    const [feed1, feed2] = await Promise.all([fd.open(), fd.open()]);
    expect(feed1).toBe(feed2);

    expect(fd.feed).toBe(feed1);
    expect(fd.feed.key).toBeInstanceOf(Buffer);
    expect(fd.opened).toBe(true);
  });

  test('Close', async () => {
    // Closing multiple times should actually close once.
    await Promise.all([fd.close(), fd.close()]);
    expect(fd.opened).toBe(false);

    fd.feed.append('test', (err) => {
      expect(err.message).toContain('This feed is not writable');
    });

    // If we try to close a feed that is opening should wait for the open result.
    const fd2 = new FeedDescriptor('/feed2', {
      storage: ram
    });

    fd2.open();
    await expect(fd2.close()).resolves.toBeUndefined();
    expect(fd.opened).toBe(false);
  });

  test('Destroy', async () => {
    const files = ['bitfield', 'key', 'signatures', 'data', 'secret_key', 'tree'];
    const root = tempy.directory();

    const fd1 = new FeedDescriptor('/feed1', {
      storage: root
    });

    await fd1.open();

    // Destroying multiple times should actually close once.
    await Promise.all([fd1.destroy(), fd1.destroy()]);
    expect(fd1.opened).toBe(false);

    await Promise.all(files.map(file => expect(fs.access(path.join(root, file))).rejects.toThrow(/ENOENT/)));

    const fd2 = new FeedDescriptor('/feed2', {
      storage: ram
    });

    await expect(fd2.destroy()).resolves.toBeUndefined();
  });

  test('Watch data', async (done) => {
    const fd = new FeedDescriptor('/feed', {
      storage: ram
    });

    await fd.open();

    fd.watch((event, feed, descriptor) => {
      expect(event).toBe('append');
      expect(feed).toBe(fd.feed);
      expect(descriptor).toBe(fd);
      fd.watch(null);
      fd.feed.append('test2', () => {
        done();
      });
    });

    fd.feed.append('test');
  });

  test('on open error should unlock the resource', async () => {
    const fd = new FeedDescriptor('/foo', {
      storage: ram,
      hypercore: () => {
        throw new Error('open error');
      }
    });

    await expect(fd.open()).rejects.toThrow(/open error/);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });

  test('on close error should unlock the resource', async () => {
    const fd = new FeedDescriptor('/foo', {
      storage: ram,
      hypercore: () => ({
        opened: true,
        on () {},
        ready (cb) { cb(); },
        close () {
          throw new Error('close error');
        }
      })
    });

    await fd.open();

    await expect(fd.close()).rejects.toThrow(/close error/);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });

  test('on destroy should unlock the resource', async () => {
    const fd = new FeedDescriptor('/feed', {
      storage: ram
    });

    await fd.open();
    await fd.close();

    fd.feed._storage = null;
    await expect(fd.destroy()).rejects.toThrow(/read property/);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });
});
