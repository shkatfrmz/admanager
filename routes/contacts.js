const express = require('express');
const router = express.Router();
const adService = require('../services/ad.service');
const audit = require('../services/audit.service');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    const contacts = await adService.searchContacts(search || null);
    res.json({ success: true, count: contacts.length, contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:name', async (req, res) => {
  try {
    const contact = await adService.findContact(req.params.name);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true, contact });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const result = await adService.createContact(req.body);
    const performer = req.user?.username || 'unknown';
    audit.log('create', 'contact', req.body.name, result.dn, performer);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:dn', async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.updateContact(dn, req.body);
    const performer = req.user?.username || 'unknown';
    audit.log('modify', 'contact', dn, dn, performer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:dn', async (req, res) => {
  try {
    const dn = decodeURIComponent(req.params.dn);
    const result = await adService.deleteContact(dn);
    const performer = req.user?.username || 'unknown';
    audit.log('delete', 'contact', dn, dn, performer);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
