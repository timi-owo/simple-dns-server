'use strict';

// ----------------------------------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------------------------------

const util = require('node:util');
const dgram = require('node:dgram');
const { Buffer } = require('node:buffer');

const g_server = dgram.createSocket('udp4');

const DNS = {

    RCODE: {

        'NO_ERROR':         0,
        'FORMAT_ERROR':     1,
        'SERVER_FAILURE':   2,
        'NAME_NOT_FOUND':   3,
        'NOT_IMPLEMENTED':  4,
        'REFUSED':          5,

        0: 'NO_ERROR',
        1: 'FORMAT_ERROR',
        2: 'SERVER_FAILURE',
        3: 'NAME_NOT_FOUND',
        4: 'NOT_IMPLEMENTED',
        5: 'REFUSED'
    },

    QTYPE: {

        'A':        1,
        'AAAA':     28,

        1:  'A',
        28: 'AAAA'
    },

    QCLASS: {

        'IN': 1,

        1: 'IN'
    }
};

// ----------------------------------------------------------------------------------------------------

g_server.on('listening', () => {

    const listen = g_server.address();
    printServerLog('Server listening at udp %s:%d', listen.address, listen.port);
});

g_server.on('message', (data, remote) => {

    let header, question;

    try
    {
        // header length
        if (data.length < 12) { throw 1; }

        header = parseHeader(data);

        // although rfc doc said multiple questions can sending at once,
        // but most clients (maybe all) sending only one question at one time,
        // so we assume this behavior for all queries.
        if (header.FLAGS.QR !== 0 || header.QDCOUNT !== 1) { throw 2; }

        // header + null question length
        if (data.length < (12 + 6)) { throw 3; }

        // possible overflow here
        question = parseQuestion(data);
    }
    catch (err)
    {
        printServerLog('Dropped malformed packet from %s:%d', remote.address, remote.port);
        return;
    }

    printServerLog('Incoming request from %s:%d', remote.address, remote.port);
    requestHandler(data, header, question, remote);
});

g_server.bind(CONFIG.LISTEN_PORT, CONFIG.LISTEN_ADDRESS);

function requestHandler(data, header, question, remote)
{
    let pass_query = false, not_implemented = false;

    // TODO: add RegEx matching support
    const record = CONFIG.MATCHING_DOMAINS_A[question.QNAME];

    if (typeof record != 'undefined' && (question.QTYPE !== DNS.QTYPE.A || question.QCLASS !== DNS.QCLASS.IN))
    {
        // TODO: add AAAA and other record type support
        not_implemented = true;

        header.FLAGS.QR = 1; // respond
        header.FLAGS.RCODE = DNS.RCODE.NOT_IMPLEMENTED;

        let h =  Buffer.alloc(12);
        let q =  Buffer.alloc(question.QNAME.length + 6);

        writeHeader(h, header);
        writeQuestion(q, question); // must be concat with header even rcode is not 0

        g_server.send(Buffer.concat([h, q]), remote.port, remote.address);
    }
    else if (typeof record == 'string')
    {
        header.FLAGS.QR = 1; // respond
        header.FLAGS.RCODE = DNS.RCODE.NO_ERROR;
        header.ANCOUNT = 1;

        let h =  Buffer.alloc(12);
        let q =  Buffer.alloc(question.QNAME.length + 6);
        let rr = Buffer.alloc(16);

        writeHeader(h, header);
        writeQuestion(q, question);
        writeResourceRecordA(rr, record, CONFIG.DEFAULT_RECORD_TTL, question);

        g_server.send(Buffer.concat([h, q, rr]), remote.port, remote.address);
    }
    else if (Array.isArray(record))
    {
        header.FLAGS.QR = 1; // respond
        header.FLAGS.RCODE = DNS.RCODE.NO_ERROR;
        header.ANCOUNT = record.length;

        let h =  Buffer.alloc(12);
        let q =  Buffer.alloc(question.QNAME.length + 6);
        let rrs = Buffer.alloc(16 * header.ANCOUNT);

        writeHeader(h, header);
        writeQuestion(q, question);

        record.forEach((each, index) => { writeResourceRecordA(rrs, each, CONFIG.DEFAULT_RECORD_TTL, question, 16 * index); });

        g_server.send(Buffer.concat([h, q, rrs]), remote.port, remote.address);
    }
    else
    {
        pass_query = true;
        passQuery(data, header, question, remote);
    }

    console.table({

        'QUESTION': {

            'ID': header.ID,
            'NAME': question.QNAME,

            'TYPE': DNS.QTYPE[question.QTYPE] !== undefined ? DNS.QTYPE[question.QTYPE] : '???',
            'CLASS': DNS.QCLASS[question.QCLASS] !== undefined ? DNS.QCLASS[question.QCLASS] : '???',

            'RECORD': pass_query || not_implemented ? 'N/A' : Array.isArray(record) ? record.join(', ') : record,
            'TTL': pass_query || not_implemented ? 0 : CONFIG.DEFAULT_RECORD_TTL,

            'STATUS': pass_query ? `PASS QUERY -> ${CONFIG.PASS_QUERY_ADDRESS}:${CONFIG.PASS_QUERY_PORT}` : not_implemented ? 'NOT_IMPLEMENTED' : 'RESOLVED'
        }
    });
}

function passQuery(data, header, question, remote)
{
    const client = dgram.createSocket('udp4');

    client.on('error', (e) => {

        // TODO: a better way to handle pass query errors.

        client.close();

        header.FLAGS.QR = 1; // respond
        header.FLAGS.RCODE = DNS.RCODE.SERVER_FAILURE;

        let h =  Buffer.alloc(12);
        let q =  Buffer.alloc(question.QNAME.length + 6);

        writeHeader(h, header);
        writeQuestion(q, question); // must be concat with header even rcode is not 0

        g_server.send(Buffer.concat([h, q]), remote.port, remote.address);
    });

    client.on('message', (data_c, remote_c) => {

        client.close();

        g_server.send(data_c, remote.port, remote.address);
    });

    client.send(data, CONFIG.PASS_QUERY_PORT, CONFIG.PASS_QUERY_ADDRESS);
}

// ----------------------------------------------------------------------------------------------------

function makeHeader(id = 0, qr = 0, opcode = 0, rcode = 0, questions = 0, answers = 0)
{
    return {

        ID: id,

        FLAGS: {

            QR: qr,
            OPCODE: opcode,
            AA: 0,
            TC: 0,
            RD: 0,
            RA: 0,
            Z: 0,
            AD: 0,
            CD: 0,
            RCODE: rcode
        },

        QDCOUNT: questions,
        ANCOUNT: answers,
        NSCOUNT: 0,
        ARCOUNT: 0
    };
}

function makeQuestion(qname = '', qtype = DNS.QTYPE.A, qclass = DNS.QCLASS.IN)
{
    return {

        QNAME: qname,
        QTYPE: qtype,
        QCLASS: qclass
    };
}

function parseHeader(data)
{
    /*
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                      ID                       |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |QR|   Opcode  |AA|TC|RD|RA| Z|AD|CD|   RCODE   |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                    QDCOUNT                    |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                    ANCOUNT                    |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                    NSCOUNT                    |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                    ARCOUNT                    |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
    */
    const raw = data.subarray(0, 12);

    let header = makeHeader(), offset = 0;

    header.ID = raw.readUInt16BE(offset);
    offset += 2;

    let flags = raw.readUInt16BE(offset);
    offset += 2;

    header.FLAGS.QR =     (flags & 0x8000) >> 15;
    header.FLAGS.OPCODE = (flags & 0x7800) >> 11;
    header.FLAGS.AA =     (flags & 0x400)  >> 10;
    header.FLAGS.TC =     (flags & 0x200)  >> 9;
    header.FLAGS.RD =     (flags & 0x100)  >> 8;
    header.FLAGS.RA =     (flags & 0x80)   >> 7;
    header.FLAGS.Z =      (flags & 0x40)   >> 6;
    header.FLAGS.AD =     (flags & 0x20)   >> 5;
    header.FLAGS.CD =     (flags & 0x10)   >> 4;
    header.FLAGS.RCODE =   flags & 0xf;

    header.QDCOUNT = raw.readUInt16BE(offset);
    offset += 2;

    header.ANCOUNT = raw.readUInt16BE(offset);
    offset += 2;

    header.NSCOUNT = raw.readUInt16BE(offset);
    offset += 2;

    header.ARCOUNT = raw.readUInt16BE(offset);
    offset += 2;

    return header;
}

function parseQuestion(data)
{
    /*
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                                               |
        /                     QNAME                     /
        /                                               /
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                     QTYPE                     |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                     QCLASS                    |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
    */
    const raw = data.subarray(12);

    let hostname = '', length = 0, offset = 0;

    length = raw.readUInt8(offset);
    offset += 1;

    while (length > 0)
    {
        hostname += raw.subarray(offset, offset + length).toString();
        offset += length;

        length = raw.readUInt8(offset);
        offset += 1;

        if (length > 0) { hostname += '.'; }
    }

    let qtype = raw.readUInt16BE(offset);
    offset += 2;

    let qclass = raw.readUInt16BE(offset);
    offset += 2;

    return makeQuestion(hostname, qtype, qclass);
}

function writeHeader(out_buffer, header)
{
    let offset = 0, flags = 0;

    out_buffer.writeUInt16BE(header.ID, offset);
    offset += 2;

    flags += (header.FLAGS.QR     << 15) & 0x8000;
    flags += (header.FLAGS.OPCODE << 11) & 0x7800;
    flags += (header.FLAGS.AA     << 10) & 0x400;
    flags += (header.FLAGS.TC     << 9)  & 0x200;
    flags += (header.FLAGS.RD     << 8)  & 0x100;
    flags += (header.FLAGS.RA     << 7)  & 0x80;
    flags += (header.FLAGS.Z      << 6)  & 0x40;
    flags += (header.FLAGS.AD     << 5)  & 0x20;
    flags += (header.FLAGS.CD     << 4)  & 0x10;
    flags +=  header.FLAGS.RCODE         & 0xf;

    out_buffer.writeUInt16BE(flags, offset);
    offset += 2;

    out_buffer.writeUInt16BE(header.QDCOUNT, offset);
    offset += 2;

    out_buffer.writeUInt16BE(header.ANCOUNT, offset);
    offset += 2;

    out_buffer.writeUInt16BE(header.NSCOUNT, offset);
    offset += 2;

    out_buffer.writeUInt16BE(header.ARCOUNT, offset);
    offset += 2;

    return offset;
}

function writeQuestion(out_buffer, question)
{
    let offset = 0;

    question.QNAME.split('.').forEach((str) => {

        out_buffer.writeUInt8(str.length, offset);
        offset += 1;

        out_buffer.write(str, offset, str.length, 'ascii');
        offset += str.length;
    });

    out_buffer.writeUInt8(0, offset);
    offset += 1;

    out_buffer.writeUInt16BE(question.QTYPE, offset);
    offset += 2;

    out_buffer.writeUInt16BE(question.QCLASS, offset);
    offset += 2;

    return offset;
}

function writeResourceRecordA(out_buffer, record, ttl, question, offset = 0)
{
    /*
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                                               |
        /                                               /
        /                      NAME                     /
        |                                               |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                      TYPE                     |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                     CLASS                     |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                      TTL                      |
        |                                               |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
        |                   RDLENGTH                    |
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--|
        /                     RDATA                     /
        /                                               /
        +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
    */

    // rfc1035-4.1.4 message compression
    out_buffer.writeUInt8(192, offset); // 1100 0000 (set the message compression flags)
    out_buffer.writeUInt8(12, offset + 1); // QNAME always closely behind HEADER (start at 12 bytes)
    offset += 2;

    out_buffer.writeUInt16BE(question.QTYPE, offset);
    offset += 2;

    out_buffer.writeUInt16BE(question.QCLASS, offset);
    offset += 2;

    out_buffer.writeUInt32BE(ttl, offset);
    offset += 4;

    let record_array = record.split('.');

    out_buffer.writeUInt16BE(record_array.length, offset);
    offset += 2;

    record_array.forEach((str) => {

        out_buffer.writeUInt8(parseInt(str), offset);
        offset += 1;
    });

    return offset;
}

function fillString(str, char, length, padding_to_left = false)
{
    if (typeof str != 'string') { str = str.toString(); }

    while (str.length < length) { str = padding_to_left ? char + str : str + char; }

    return str;
}

function formatDateTime(format = 'Year-Mon-Day Hour:Min:Sec', fill_zero = true, utc_time = false)
{
    const current = new Date();

    let date = {

        year: utc_time ? current.getUTCFullYear() : current.getFullYear(),
        mon: (utc_time ? current.getUTCMonth() : current.getMonth()) + 1, // no issues at this line
        day:  utc_time ? current.getUTCDate() : current.getDate()
    };

    let time = {

        hour: utc_time ? current.getUTCHours() : current.getHours(),
        min:  utc_time ? current.getUTCMinutes() : current.getMinutes(),
        sec:  utc_time ? current.getUTCSeconds() : current.getSeconds()
    };

    format = format.replace('Year', fill_zero ? fillString(date.year, '0', 4, true) : date.year);
    format = format.replace('Mon',  fill_zero ? fillString(date.mon,  '0', 2, true) : date.mon);
    format = format.replace('Day',  fill_zero ? fillString(date.day,  '0', 2, true) : date.day);

    format = format.replace('Hour', fill_zero ? fillString(time.hour, '0', 2, true) : time.hour);
    format = format.replace('Min',  fill_zero ? fillString(time.min,  '0', 2, true) : time.min);
    format = format.replace('Sec',  fill_zero ? fillString(time.sec,  '0', 2, true) : time.sec);

    return format;
}

function printServerLog(format, ...args)
{
    for (let arg of args) { format = util.format(format, arg); }

    console.log(`[${formatDateTime()}] ${format}`);
}

