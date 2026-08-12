const { Resend } = require('resend');

async function sendPasswordResetEmail(email, resetToken) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    console.log('🔑 API Key exists:', !!apiKey);
    console.log('🔑 API Key starts with re_:', apiKey?.startsWith('re_'));
    
    const resend = new Resend(apiKey);
    console.log('📧 Sending reset email to:', email);
    
    const result = await resend.emails.send({
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
    
    console.log('✅ Email result:', result);
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    console.error('❌ Error details:', err);
    throw err;
  }
}

module.exports = { sendPasswordResetEmail };
