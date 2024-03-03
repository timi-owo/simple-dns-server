'use strict';

const dns = require('node:dns');

dns.setServers(['127.0.0.1:53']); // make sure it's right

const domains = [

    'www.example.com',
    'multi.example.com'
];

domains.forEach((domain) => {

    dns.resolve(domain, 'A', (error, records) => {

        if (error)
        {
            console.log(error);
            return;
        }

        console.log(records)
    });
});

