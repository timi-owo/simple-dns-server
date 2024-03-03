# 🌐 simple-dns-server

*a simple dns server with inline configuration, no third-party dependencies required.*

## Inline Configuration
```js
const CONFIG = {

    LISTEN_ADDRESS: '127.0.0.1',
    LISTEN_PORT: 53,

    // DNS server for other domains
    PASS_QUERY_ADDRESS: '223.5.5.5',
    PASS_QUERY_PORT: 53,

    // only record A (qtype 1) was implemented for now
    MATCHING_DOMAINS_A: {

        'www.example.com': '123.123.123.123',

        'multi.example.com': [

            '1.2.3.4',
            '11.22.33.44'
        ]
    },

    DEFAULT_RECORD_TTL: 300
};
```

## Get Started
> *Require [Node.js](https://nodejs.org) 20+*

**Run Server**
```
node dns-server
```

**Make your first query**
```
node dns-client
```
> *👆 It just few lines, give it a read, and edit on your own needs.*

