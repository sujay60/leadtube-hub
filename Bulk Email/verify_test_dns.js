const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const validator = require('deep-email-validator');

async function test() {
    console.log('Testing valid email...');
    const valid = await validator.validate('sujay60@gmail.com');
    console.log('Valid:', valid);

    console.log('Testing invalid email...');
    const invalid = await validator.validate('nonexistent123499@gmail.com');
    console.log('Invalid:', invalid);
}
test();
