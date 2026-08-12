const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendPasswordResetEmail(email, resetToken) {
  try {
    await resend.emails.send({
      from: 'onboarding@resend.dev',  // Use Resend's test domain for now, swap to noreply@headroom.me.uk once domain is verified
      to: email,
      subject: 'Reset your Headroom password',
      html: `
        <p>Hi,</p>
        <p>Click the link below to reset your Headroom password.</p>
        <p><a href="https://headroom.me.uk/reset-password?token=${resetToken}">Reset password</a></p>
        <p>This link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
        <p>Best,<br>Headroom</p>
      `,
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
    throw err;
  }
}

module.exports = { sendPasswordResetEmail };
