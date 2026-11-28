import type { TranslationDict } from './translate';

/**
 * Success messages keyed by a stable code. Controllers set the code via
 * `@ApiResponse({ message: SUCCESS_MESSAGES.* })`; `ResponseInterceptor`
 * localizes it using `request.language`. The default `SUCCESS` code is applied
 * when a handler sets no explicit message.
 */
export const SUCCESS_TRANSLATIONS = {
  // Generic (default response message)
  SUCCESS: { vi: 'Thành công', en: 'Success' },

  // Auth
  LOGIN_SUCCESS: { vi: 'Đăng nhập thành công', en: 'Login successful' },
  LOGOUT_SUCCESS: { vi: 'Đăng xuất thành công', en: 'Logout successful' },
  REGISTER_SUCCESS: { vi: 'Đăng ký thành công', en: 'Registration successful' },
  TOKEN_REFRESHED: { vi: 'Làm mới token thành công', en: 'Token refreshed' },
  FORGOT_PASSWORD_SUCCESS: {
    vi: 'Nếu email đã được đăng ký, mã xác nhận sẽ được gửi tới email đó',
    en: 'If the email is registered, a reset code will be sent to it',
  },
  RESET_PASSWORD_SUCCESS: { vi: 'Đặt lại mật khẩu thành công', en: 'Reset password successful' },

  // Class
  CLASS_CREATED: { vi: 'Tạo lớp học thành công', en: 'Class created successfully' },
  CLASSES_FETCHED: { vi: 'Lấy danh sách lớp học thành công', en: 'Classes fetched successfully' },
  CLASS_FETCHED: { vi: 'Lấy thông tin lớp học thành công', en: 'Class fetched successfully' },
  CLASS_DELETED: { vi: 'Xóa lớp học thành công', en: 'Class deleted successfully' },
  STUDENTS_ADDED: { vi: 'Thêm học sinh vào lớp thành công', en: 'Students added successfully' },
  STUDENTS_FETCHED: {
    vi: 'Lấy danh sách học sinh thành công',
    en: 'Students fetched successfully',
  },

  // Curriculum
  CURRICULUM_CREATED: {
    vi: 'Tạo chương trình học thành công',
    en: 'Curriculum created successfully',
  },
  CURRICULUMS_FETCHED: {
    vi: 'Lấy danh sách chương trình học thành công',
    en: 'Curriculums fetched successfully',
  },
  CURRICULUM_FETCHED: {
    vi: 'Lấy chương trình học thành công',
    en: 'Curriculum fetched successfully',
  },
  CURRICULUM_UPDATED: {
    vi: 'Cập nhật chương trình học thành công',
    en: 'Curriculum updated successfully',
  },
  CURRICULUM_DELETED: {
    vi: 'Xóa chương trình học thành công',
    en: 'Curriculum deleted successfully',
  },

  // Chapter
  CHAPTER_CREATED: { vi: 'Tạo chương thành công', en: 'Chapter created successfully' },
  CHAPTERS_FETCHED: { vi: 'Lấy danh sách chương thành công', en: 'Chapters fetched successfully' },
  CHAPTER_FETCHED: { vi: 'Lấy chương thành công', en: 'Chapter fetched successfully' },
  CHAPTER_UPDATED: { vi: 'Cập nhật chương thành công', en: 'Chapter updated successfully' },
  CHAPTER_DELETED: { vi: 'Xóa chương thành công', en: 'Chapter deleted successfully' },

  // Lesson
  LESSON_CREATED: { vi: 'Tạo bài học thành công', en: 'Lesson created successfully' },
  LESSONS_FETCHED: { vi: 'Lấy danh sách bài học thành công', en: 'Lessons fetched successfully' },
  LESSON_FETCHED: { vi: 'Lấy bài học thành công', en: 'Lesson fetched successfully' },
  LESSON_UPDATED: { vi: 'Cập nhật bài học thành công', en: 'Lesson updated successfully' },
  LESSON_DELETED: { vi: 'Xóa bài học thành công', en: 'Lesson deleted successfully' },

  // Session
  SESSION_CREATED: { vi: 'Tạo buổi học thành công', en: 'Session created successfully' },
  SESSIONS_FETCHED: {
    vi: 'Lấy danh sách buổi học thành công',
    en: 'Sessions fetched successfully',
  },
  SESSION_FETCHED: { vi: 'Lấy buổi học thành công', en: 'Session fetched successfully' },
  SESSION_UPDATED: { vi: 'Cập nhật buổi học thành công', en: 'Session updated successfully' },
  SESSION_DELETED: { vi: 'Xóa buổi học thành công', en: 'Session deleted successfully' },

  // Schedule
  SCHEDULE_CREATED: { vi: 'Tạo lịch học thành công', en: 'Schedule created successfully' },
  SCHEDULES_FETCHED: {
    vi: 'Lấy danh sách lịch học thành công',
    en: 'Schedules fetched successfully',
  },
  SCHEDULE_UPDATED: { vi: 'Cập nhật lịch học thành công', en: 'Schedule updated successfully' },
  SCHEDULE_DELETED: { vi: 'Xóa lịch học thành công', en: 'Schedule deleted successfully' },

  // Exercise
  EXERCISE_CREATED: { vi: 'Tạo bài tập thành công', en: 'Exercise created successfully' },
  EXERCISES_FETCHED: {
    vi: 'Lấy danh sách bài tập thành công',
    en: 'Exercises fetched successfully',
  },
  EXERCISE_SUBMITTED: { vi: 'Nộp bài tập thành công', en: 'Exercise submitted successfully' },
  EXERCISE_GRADED: { vi: 'Chấm bài tập thành công', en: 'Exercise graded successfully' },

  // User
  USER_CREATED: { vi: 'Tạo người dùng thành công', en: 'User created successfully' },
  USERS_FETCHED: { vi: 'Lấy danh sách người dùng thành công', en: 'Users fetched successfully' },
  USER_FETCHED: { vi: 'Lấy thông tin người dùng thành công', en: 'User fetched successfully' },
  USER_UPDATED: { vi: 'Cập nhật người dùng thành công', en: 'User updated successfully' },
  USER_DELETED: { vi: 'Xóa người dùng thành công', en: 'User deleted successfully' },
  PASSWORD_UPDATED: { vi: 'Cập nhật mật khẩu thành công', en: 'Password updated successfully' },

  // Notification
  NOTIFICATIONS_FETCHED: {
    vi: 'Lấy danh sách thông báo thành công',
    en: 'Notifications fetched successfully',
  },
  NOTIFICATION_READ: { vi: 'Đã đánh dấu đã đọc thông báo', en: 'Notification marked as read' },

  // Tuition
  TUITION_CREATED: { vi: 'Tạo học phí thành công', en: 'Tuition created successfully' },
  TUITIONS_FETCHED: {
    vi: 'Lấy danh sách học phí thành công',
    en: 'Tuitions fetched successfully',
  },
  TUITION_UPDATED: { vi: 'Cập nhật học phí thành công', en: 'Tuition updated successfully' },

  // Upload
  FILE_UPLOADED: { vi: 'Tải tệp lên thành công', en: 'File uploaded successfully' },
} as const satisfies TranslationDict;
