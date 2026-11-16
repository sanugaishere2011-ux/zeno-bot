
const express = require('express');
const app = express();

const path = require('path');
const PORT = process.env.PORT || 8000;

require('events').EventEmitter.defaultMaxListeners = 500;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const code = require('./pair');

app.use('/code', code);

app.get('/pair', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'pair.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'main.html'));
});

app.listen(PORT, () => {
    console.log(`Zeno Bot server running on port ${PORT}`);
});

module.exports = app;
