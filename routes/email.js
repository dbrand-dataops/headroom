const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendPasswordResetEmail(email, resetToken) {
  try {
    await resend.emails.send({
      from: 'noreply@headroom.me.uk', // Resend will verify this domain
      to: email,
      subject: 'Reset your Headroom password',
      html: `
        <p>Click the link below to reset your password.</p>
        <p><a href="https://headroom.me.uk/reset-password?token=${resetToken}">Reset password</a></p>
        <p>This link expires in 1 hour.</p>
        <p>If you didn't request this, ignore this email.</p>
      `,
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
    throw err;
  }
}

module.exports = { sendPasswordResetEmail };
