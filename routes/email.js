const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendPasswordResetEmail(email, resetToken) {
  console.log('🚀 sendPasswordResetEmail called', { email, apiKeyExists: !!process.env.RESEND_API_KEY });
  try {
    console.log('📧 Sending email via Resend...');
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: email,
      subject: 'Reset your Headroom password',
      html: `...`,
    });
    console.log('✅ Email sent successfully');
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    throw err;
  }
}
