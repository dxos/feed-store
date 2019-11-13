//
// Copyright 2019 DxOS.
//

import hypertrie from 'hypertrie';
import tempy from 'tempy';
import ram from 'random-access-memory';
import hypercore from 'hypercore';
import pify from 'pify';

import FeedStore from './feed-store';

describe('FeedStore', () => {
  let booksFeed;
  let usersFeed;
  let groupsFeed;
  let feedStore;
  const directory = tempy.directory();

  function createDefault () {
    return FeedStore.create(hypertrie(directory), directory, { feedOptions: { valueEncoding: 'utf-8' } });
  }

  test('Config with db and valueEncoding utf-8', async () => {
    feedStore = await createDefault();

    expect(feedStore).toBeInstanceOf(FeedStore);
  });

  test('Create feed', async () => {
    booksFeed = await feedStore.openFeed('/books');
    expect(booksFeed).toBeInstanceOf(hypercore);
    expect(FeedStore.getDescriptor(booksFeed)).toHaveProperty('path', '/books');
    await pify(booksFeed.append.bind(booksFeed))('Foundation and Empire');
    await expect(pify(booksFeed.head.bind(booksFeed))()).resolves.toBe('Foundation and Empire');
    // It should return the same opened instance.
    expect(feedStore.openFeed('/books')).resolves.toBe(booksFeed);
    // You can't open a feed with a different key.
    await expect(feedStore.openFeed('/books', { key: Buffer.from('...') })).rejects.toThrow(/different public key/);
    await expect(feedStore.openFeed('/foo', { key: booksFeed.key })).rejects.toThrow(/already a feed registered with the public key/);
  });

  test('Create duplicate feed', async () => {
    const [feed1, feed2] = await Promise.all([feedStore.openFeed('/users'), feedStore.openFeed('/users')]);
    expect(feed1).toBe(feed2);
    usersFeed = feed1;
    groupsFeed = await feedStore.openFeed('/groups');

    await pify(usersFeed.append.bind(usersFeed))('alice');
    await expect(pify(usersFeed.head.bind(usersFeed))()).resolves.toBe('alice');
  });

  test('Create and close a feed', async () => {
    await expect(feedStore.closeFeed('/fooo')).rejects.toThrow(/Feed not found/);
    await feedStore.closeFeed('/groups');
    expect(groupsFeed.closed).toBe(true);
  });

  test('Descriptors', async () => {
    expect(feedStore.getDescriptors().map(fd => fd.path)).toEqual(['/books', '/users', '/groups']);
    expect(feedStore.getOpenedDescriptors().map(fd => fd.path)).toEqual(['/books', '/users']);
    expect(feedStore.getDescriptorByKey(booksFeed.key)).toHaveProperty('path', '/books');
    expect(feedStore.getDescriptorByPath('/books')).toHaveProperty('key', booksFeed.key);
  });

  test('Feeds', async () => {
    expect(feedStore.getFeeds().map(f => f.key)).toEqual([booksFeed.key, usersFeed.key]);
    expect(feedStore.findFeed(fd => fd.key.equals(booksFeed.key))).toBe(booksFeed);
    expect(feedStore.filterFeeds(fd => fd.path === '/books')).toEqual([booksFeed]);
  });

  test('Load feed', async () => {
    const [feed] = await feedStore.loadFeeds(fd => fd.path === '/groups');
    expect(feed).toBeDefined();
    expect(feed.key).toEqual(groupsFeed.key);
    expect(feedStore.getDescriptorByPath('/groups')).toHaveProperty('opened', true);
  });

  test('Close feedStore and their feeds', async () => {
    await feedStore.close();
    expect(feedStore.getOpenedDescriptors().length).toBe(0);
  });

  test('Reopen feedStore and recreate feeds from the indexDB', async () => {
    feedStore = await createDefault();

    expect(feedStore).toBeInstanceOf(FeedStore);
    expect(feedStore.getDescriptors().length).toBe(3);

    const booksFeed = await feedStore.openFeed('/books');
    const [usersFeed] = await feedStore.loadFeeds(fd => fd.path === '/users');
    expect(feedStore.getOpenedDescriptors().length).toBe(2);

    await expect(pify(booksFeed.head.bind(booksFeed))()).resolves.toBe('Foundation and Empire');
    await expect(pify(usersFeed.head.bind(usersFeed))()).resolves.toBe('alice');
  });

  test('Delete descriptor', async () => {
    await feedStore.deleteDescriptor('/books');
    expect(feedStore.getDescriptors().length).toBe(2);
  });

  test('Default codec: binary', async () => {
    const feedStore = await FeedStore.create(hypertrie(ram), ram);
    expect(feedStore).toBeInstanceOf(FeedStore);

    const feed = await feedStore.openFeed('/test');
    expect(feed).toBeInstanceOf(hypercore);
    await pify(feed.append.bind(feed))('test');
    await expect(pify(feed.head.bind(feed))()).resolves.toBeInstanceOf(Buffer);
  });

  test('Default codec: json + custom codecs', async () => {
    const options = {
      feedOptions: { valueEncoding: 'utf-8' },
      codecs: {
        codecA: {
          encode (val) {
            val.encodedBy = 'codecA';
            return Buffer.from(JSON.stringify(val));
          },
          decode (val) {
            return JSON.parse(val);
          }
        }
      }
    };
    const feedStore = await FeedStore.create(hypertrie(ram), ram, options);
    expect(feedStore).toBeInstanceOf(FeedStore);

    {
      const feed = await feedStore.openFeed('/test');
      expect(feed).toBeInstanceOf(hypercore);
      await pify(feed.append.bind(feed))('test');
      await expect(pify(feed.head.bind(feed))()).resolves.toBe('test');
    }
    {
      const feed = await feedStore.openFeed('/a', { valueEncoding: 'codecA' });
      expect(feed).toBeInstanceOf(hypercore);
      await pify(feed.append.bind(feed))({ msg: 'test' });
      await expect(pify(feed.head.bind(feed))()).resolves.toEqual({ msg: 'test', encodedBy: 'codecA' });
    }
  });

  test('on open error should unlock the descriptor', async () => {
    const feedStore = await FeedStore.create(
      hypertrie(ram),
      ram,
      {
        hypercore: () => {
          throw new Error('open error');
        }
      }
    );

    await expect(feedStore.openFeed('/foo')).rejects.toThrow(/open error/);

    const fd = feedStore.getDescriptorByPath('/foo');
    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });

  test('on close error should unlock the descriptor', async () => {
    const feedStore = await FeedStore.create(
      hypertrie(ram),
      ram,
      {
        hypercore: () => ({
          opened: true,
          ready (cb) { cb(); },
          on () {},
          close () {
            throw new Error('close error');
          }
        })
      }
    );

    const feed = await feedStore.openFeed('/foo');
    const fd = FeedStore.getDescriptor(feed);

    await expect(feedStore.closeFeed('/foo')).rejects.toThrow(/close error/);
    await expect(feedStore.close()).rejects.toThrow(/close error/);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });

  test('on delete descriptor error should unlock the descriptor', async () => {
    const feedStore = await FeedStore.create(
      hypertrie(ram),
      ram
    );

    const feed = await feedStore.openFeed('/foo');
    const fd = FeedStore.getDescriptor(feed);

    // We remove the indexDB to force an error.
    feedStore._indexDB = null;

    await expect(feedStore.deleteDescriptor('/foo')).rejects.toThrow(Error);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });
});
