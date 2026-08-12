const { Resend } = require('resend');

async function sendPasswordResetEmail(email, resetToken) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  
  try {
    console.log('📧 Sending reset email to:', email);
    await resend.emails.send({
      from: 'onboarding@resend.dev',
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
    console.log('✅ Email sent successfully to:', email);
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    throw err;
  }
}

module.exports = { sendPasswordResetEmail };
