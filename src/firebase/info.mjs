
// Note that 'firestore-lite' cannot be used with 'firebase-admin'.
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// you can get create a private key here:
// https://console.firebase.google.com/u/0/project/chandalair-8bf5b/settings/serviceaccounts
const serviceAccount = JSON.parse(readFileSync('./chandalair-8bf5b-firebase-adminsdk-wdq0z-3fe5d11337.json'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// https://firebase.google.com/docs/reference/node/firebase.firestore.Firestore
const db = admin.firestore();

// old format from https://nuru.nu/chandalair/
async function oldListEvents(details) {
  console.log('events:');
  const snapshot = await db.collection('events').limit(0).get();
  const bysess = new Map();
  snapshot.forEach(doc => {
    console.log('id', doc.id);
    const data = doc.data();
    if (!bysess.has(data.session_ms)) bysess.set(data.session_ms, []);
    bysess.get(data.session_ms).push(data);
    // console.log('data', data);
  });
  const words = s => (s || '').match(/\w+/g)?.length || 0;
  for (const [ms, msgs] of bysess.entries()) {
    console.log('Session', ms, new Date(ms));
    for (const msg of msgs) {
      console.log(
          '  -', msg.event, msg.dt, new Date(msg.t),
          'manual', words(msg.manual),
          'text', words(msg.text),
          'reply', words(msg.reply),
      );
    }
    console.log();
  }
  if (details) {
    console.log('Details', details, new Date(details));
    for (const msg of bysess.get(details)) {
      console.log(msg);
    }
  }
}

// oldListEvents(1681068928778);


function summary(conv) {
  const d = new Date(conv[0].id);
  const secs = (conv[conv.length - 1].id - conv[0].id) / 1000;
  const minutes = Math.round(secs / 6) / 10;
  const date = d.toDateString();
  const time = d.toTimeString().split(' ')[0];
  const words = (messages) => messages.map(
     message => (message.text || '').match(/\w+/g)?.length || 0
  ).reduce((prev, cur) => prev + cur, 0);
  const liarConv = conv.filter((message) =>
      message.role === 'assistant');
  const convLength = conv.length;
  const convWords = words(conv);
  const liarLength = liarConv.length;
  const liarWords = words(liarConv);
  return {date, time, minutes, convLength, convWords, liarLength, liarWords};
}

async function listConversations(user, limit) {
  const path = `users/${user}/conversation`;
  let n = 0, words = 0, msgs = 0, liarWords = 0, liarMsgs = 0;
  const byday = {};
  console.log('user', user);
  (await db.collection(path).limit(0).get()).forEach(doc => {
    try {
      const s = summary(doc.data().conversation);
      console.log(`${doc.id}: ${s.date} ${s.time} - ${s.minutes} min - ${s.convLength} msgs, ${s.convWords} words - liar ${s.liarLength} msgs, ${s.liarWords} words`);
      byday[s.date] = (byday[s.date] || 0) + 1;
      n++;
      msgs += s.convLength;
      words += s.convWords;
      liarMsgs += s.liarLength;
      liarWords += s.liarWords;
    } catch (e) {
      console.error('could not process', e, 'path', `${path}/${doc.id}`);
    }
  });
  console.log('byday', byday);
  console.log(`total ${n} - ${msgs} msgs ${words} words - liar ${liarMsgs} msgs ${liarWords} words`);
  const avg = x => Math.round(10 * x / n) / 10;
  console.log(`avg ${avg(msgs)} msgs ${avg(words)} words - liar ${avg(liarMsgs)} msgs ${avg(liarWords)} words`);
  console.log();
}

async function listAllConversations(limit) {
  const docs = [];
  (await db.collection('users').limit(0).get()).forEach(doc => docs.push(doc));
  for (const doc of docs) {
    await listConversations(doc.id, limit);
  }
}


listAllConversations(0);


async function show(path) {
  console.log((await db.doc(path).get()).data());
}

// show('users/YZecRWH8YHPQtmP1CDgrE81RX612/conversation/1684821778064');